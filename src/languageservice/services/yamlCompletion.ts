/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TextDocument, TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument';
import { ClientCapabilities } from 'vscode-languageserver';
import {
  CompletionItem as CompletionItemBase,
  CompletionItemKind,
  CompletionList,
  InsertTextFormat,
  InsertTextMode,
  MarkupContent,
  MarkupKind,
  Position,
  Range,
  TextEdit,
} from 'vscode-languageserver-types';
import { Node, isPair, isScalar, isMap, YAMLMap, isSeq, YAMLSeq, isNode, Pair } from 'yaml';
import { Telemetry } from '../telemetry';
import { SingleYAMLDocument, YamlDocuments } from '../parser/yaml-documents';
import { YamlVersion } from '../parser/yamlParser07';
import { filterInvalidCustomTags, matchOffsetToDocument } from '../utils/arrUtils';
import { guessIndentation } from '../utils/indentationGuesser';
import { TextBuffer } from '../utils/textBuffer';
import { LanguageSettings } from '../yamlLanguageService';
import { YAMLSchemaService } from './yamlSchemaService';
import { ResolvedSchema } from 'vscode-json-languageservice/lib/umd/services/jsonSchemaService';
import { JSONSchema, JSONSchemaRef } from '../jsonSchema';
import { stringifyObject, StringifySettings } from '../utils/json';
import { isDefined, isString } from '../utils/objects';
import * as nls from 'vscode-nls';
import { setKubernetesParserOption } from '../parser/isKubernetes';
import { asSchema } from '../parser/jsonParser07';
import { indexOf, isInComment, isMapContainsEmptyPair } from '../utils/astUtils';
import { isModeline } from './modelineUtil';
import { getSchemaTypeName, isAnyOfAllOfOneOfType, isPrimitiveType } from '../utils/schemaUtils';
import { YamlNode } from '../jsonASTTypes';

const localize = nls.loadMessageBundle();

const doubleQuotesEscapeRegExp = /[\\]+"/g;

const parentCompletionKind = CompletionItemKind.Class;

const existingProposeItem = '__';

interface ParentCompletionItemOptions {
  schema: JSONSchema;
  indent?: string;
  insertTexts?: string[];
}

interface CompletionItem extends CompletionItemBase {
  parent?: ParentCompletionItemOptions;
}
interface CompletionsCollector {
  add(suggestion: CompletionItem, oneOfSchema?: boolean): void;
  error(message: string): void;
  log(message: string): void;
  getNumberOfProposals(): number;
  result: CompletionList;
  proposed: { [key: string]: CompletionItem };
}

interface InsertText {
  insertText: string;
  insertIndex: number;
}

export const expressionSchemaName = 'expression';

export class YamlCompletion {
  private customTags: string[];
  private completionEnabled = true;
  private configuredIndentation: string | undefined;
  private yamlVersion: YamlVersion;
  private indentation: string;
  private arrayPrefixIndentation = '';
  private supportsMarkdown: boolean | undefined;
  private disableDefaultProperties: boolean;
  private parentSkeletonSelectedFirst: boolean;

  constructor(
    private schemaService: YAMLSchemaService,
    private clientCapabilities: ClientCapabilities = {},
    private yamlDocument: YamlDocuments,
    private readonly telemetry?: Telemetry
  ) {}

  configure(languageSettings: LanguageSettings): void {
    if (languageSettings) {
      this.completionEnabled = languageSettings.completion;
    }
    this.customTags = languageSettings.customTags;
    this.yamlVersion = languageSettings.yamlVersion;
    this.configuredIndentation = languageSettings.indentation;
    this.disableDefaultProperties = languageSettings.disableDefaultProperties;
    this.parentSkeletonSelectedFirst = languageSettings.parentSkeletonSelectedFirst;
  }

  async doComplete(document: TextDocument, position: Position, isKubernetes = false, doComplete = true): Promise<CompletionList> {
    let result = CompletionList.create([], false);
    if (!this.completionEnabled) {
      return result;
    }
    // const startTime = Date.now();
    const offset = document.offsetAt(position);
    const textBuffer = new TextBuffer(document);
    const lineContent = textBuffer.getLineContent(position.line);
    if (!this.configuredIndentation) {
      const indent = guessIndentation(textBuffer, 2, true);
      this.indentation = indent.insertSpaces ? ' '.repeat(indent.tabSize) : '\t';
      this.configuredIndentation = this.indentation; // to cache this result
    } else {
      this.indentation = this.configuredIndentation;
    }

    // auto add space after : if needed
    if (document.getText().charAt(offset - 1) === ':') {
      const newPosition = Position.create(position.line, position.character + 1);
      result = await this.doCompletionWithModification(result, document, position, isKubernetes, doComplete, newPosition, ' ');
    } else {
      result = await this.doCompleteWithDisabledAdditionalProps(document, position, isKubernetes, doComplete);
    }

    // try as a object if is on property line
    if (lineContent.match(/:\s*$/)) {
      const lineIndentMatch = lineContent.match(/^\s*(- )?/);
      const lineIndent = lineIndentMatch[0].replace('-', ' ');
      const arrayIndentCompensation = lineIndentMatch[1]?.replace('-', ' ') || '';
      const fullIndent = lineIndent + this.indentation;
      const modificationForInvoke = '\n' + fullIndent;
      const firstPrefix = '\n' + this.indentation;
      const newPosition = Position.create(position.line + 1, fullIndent.length);
      result = await this.doCompletionWithModification(
        result,
        document,
        position,
        isKubernetes,
        doComplete,
        newPosition,
        modificationForInvoke,
        firstPrefix + arrayIndentCompensation,
        this.indentation + arrayIndentCompensation
      );
      if (result.items.length === 0) {
        // try with array symbol
        result = await this.doCompletionWithModification(
          result,
          document,
          position,
          isKubernetes,
          doComplete,
          Position.create(newPosition.line, newPosition.character + 2),
          modificationForInvoke + '- ',
          firstPrefix + arrayIndentCompensation + '- ',
          this.indentation + arrayIndentCompensation
        );
      }
    }

    // if no suggestions and if on an empty line then try as an array
    if (result.items.length === 0 && lineContent.match(/^\s*$/)) {
      const modificationForInvoke = '-';
      const newPosition = Position.create(position.line, position.character + 1);
      result = await this.doCompletionWithModification(
        result,
        document,
        position,
        isKubernetes,
        doComplete,
        newPosition,
        modificationForInvoke
      );
    }

    // const secs = (Date.now() - startTime) / 1000;
    // console.log(
    //   `[debug] completion: lineContent(${lineContent.replace('\n', '\\n')}), resultCount(${result.items.length}), time(${secs})`
    // );

    return result;
  }

  private async doCompletionWithModification(
    result: CompletionList,
    document: TextDocument,
    position: Position, // original position
    isKubernetes: boolean,
    doComplete: boolean,
    newPosition: Position, // new position
    modificationForInvoke: string,
    firstPrefix = modificationForInvoke,
    eachLinePrefix = ''
  ): Promise<CompletionList> {
    const newDocument = this.updateTextDocument(document, [
      { range: Range.create(position, position), text: modificationForInvoke },
    ]);
    const resultLocal = await this.doCompleteWithDisabledAdditionalProps(newDocument, newPosition, isKubernetes, doComplete);
    resultLocal.items.map((item) => {
      let firstPrefixLocal = firstPrefix;
      // if there is single space (space after colon) and insert text already starts with \n (it's a object), don't add space
      // example are snippets
      if (item.insertText.startsWith('\n') && firstPrefix === ' ') {
        firstPrefixLocal = '';
      }
      if (item.insertText) {
        item.insertText = firstPrefixLocal + item.insertText.replace(/\n/g, '\n' + eachLinePrefix);
      }
      if (item.textEdit) {
        item.textEdit.newText = firstPrefixLocal + item.textEdit.newText.replace(/\n/g, '\n' + eachLinePrefix);
        if (TextEdit.is(item.textEdit)) {
          item.textEdit.range = Range.create(position, position);
        }
      }
    });
    // remove tmp document
    this.yamlDocument.delete(newDocument);

    if (!result.items.length) {
      result = resultLocal;
      return result;
    }

    // join with previous result, but remove the duplicity (snippet for example cause the duplicity)
    resultLocal.items.forEach((item) => {
      const isEqual = (itemA: CompletionItemBase, itemB: CompletionItemBase): boolean =>
        // trim insert text to join problematic array object completion https://github.com/redhat-developer/yaml-language-server/issues/620
        itemA.label === itemB.label && itemA.insertText.trimLeft() === itemB.insertText.trimLeft() && itemA.kind === itemB.kind;

      if (!result.items.some((resultItem) => isEqual(resultItem, item))) {
        result.items.push(item);
      }
    });
    return result;
  }

  private updateTextDocument(document: TextDocument, changes: TextDocumentContentChangeEvent[]): TextDocument {
    // generates unique name for the file. Note that this has impact to config
    const tmpUri = addUniquePostfix(document.uri);
    const newDoc = TextDocument.create(tmpUri, document.languageId, -1, document.getText());
    TextDocument.update(newDoc, changes, 0);
    return newDoc;
  }

  private async doCompleteWithDisabledAdditionalProps(
    document: TextDocument,
    position: Position,
    isKubernetes = false,
    doComplete: boolean
  ): Promise<CompletionList> {
    // update yaml parser settings
    const doc = this.yamlDocument.getYamlDocument(document, { customTags: this.customTags, yamlVersion: this.yamlVersion }, true);
    doc.documents.forEach((doc) => {
      doc.disableAdditionalProperties = true;
    });
    return this.doCompleteInternal(document, position, isKubernetes, doComplete);
  }

  private async doCompleteInternal(
    document: TextDocument,
    position: Position,
    isKubernetes = false,
    doComplete: boolean
  ): Promise<CompletionList> {
    const result = CompletionList.create([], false);
    if (!this.completionEnabled) {
      return result;
    }
    const doc = this.yamlDocument.getYamlDocument(document, { customTags: this.customTags, yamlVersion: this.yamlVersion }, true);
    const textBuffer = new TextBuffer(document);

    if (!this.configuredIndentation) {
      const indent = guessIndentation(textBuffer, 2, true);
      this.indentation = indent.insertSpaces ? ' '.repeat(indent.tabSize) : '\t';
    } else {
      this.indentation = this.configuredIndentation;
    }

    setKubernetesParserOption(doc.documents, isKubernetes);

    // set parser options
    for (const jsonDoc of doc.documents) {
      jsonDoc.uri = document.uri;
    }

    const offset = document.offsetAt(position);
    const text = document.getText();

    if (text.charAt(offset - 1) === ':') {
      return Promise.resolve(result);
    }

    let currentDoc = matchOffsetToDocument(offset, doc);
    if (currentDoc === null) {
      return Promise.resolve(result);
    }

    // as we modify AST for completion, we need to use copy of original document
    currentDoc = currentDoc.clone();

    let [node, foundByClosest] = currentDoc.getNodeFromPosition(offset, textBuffer, this.indentation.length);

    const currentWord = this.getCurrentWord(document, offset);
    let lineContent = textBuffer.getLineContent(position.line);
    const lineAfterPosition = lineContent.substring(position.character);
    const areOnlySpacesAfterPosition = /^[ ]+\n?$/.test(lineAfterPosition);

    this.arrayPrefixIndentation = '';
    let overwriteRange: Range = null;
    const isOnlyHyphen = lineContent.match(/^\s*(-)\s*($|#)/);
    if (areOnlySpacesAfterPosition) {
      overwriteRange = Range.create(position, Position.create(position.line, lineContent.length));
      const isOnlyWhitespace = lineContent.trim().length === 0;
      if (node && isScalar(node) && !isOnlyWhitespace && !isOnlyHyphen) {
        const lineToPosition = lineContent.substring(0, position.character);
        const matches =
          // get indentation of unfinished property (between indent and cursor)
          lineToPosition.match(/^[\s-]*([^:]+)?$/) ||
          // OR get unfinished value (between colon and cursor)
          lineToPosition.match(/:[ \t]((?!:[ \t]).*)$/);

        if (matches?.[1]) {
          overwriteRange = Range.create(
            Position.create(position.line, position.character - matches[1].length),
            Position.create(position.line, lineContent.length)
          );
        }
      } else if (node && isScalar(node) && node.value === null && currentWord === '-') {
        this.arrayPrefixIndentation = ' ';
      }
    } else if (node && isScalar(node) && node.value === 'null') {
      const nodeStartPos = document.positionAt(node.range[0]);
      nodeStartPos.character += 1;
      const nodeEndPos = document.positionAt(node.range[2]);
      nodeEndPos.character += 1;
      overwriteRange = Range.create(nodeStartPos, nodeEndPos);
    } else if (node && isScalar(node) && node.value) {
      const start = document.positionAt(node.range[0]);
      overwriteRange = Range.create(start, document.positionAt(node.range[1]));
    } else if (node && isScalar(node) && node.value === null && currentWord === '-') {
      overwriteRange = Range.create(position, position);
      this.arrayPrefixIndentation = ' ';
    } else {
      let overwriteStart = offset - currentWord.length;
      if (overwriteStart > 0 && text[overwriteStart - 1] === '"') {
        overwriteStart--;
      }
      overwriteRange = Range.create(document.positionAt(overwriteStart), position);
    }

    const proposed: { [key: string]: CompletionItem } = {};
    const collector: CompletionsCollector = {
      add: (completionItem: CompletionItem, oneOfSchema: boolean) => {
        const addSuggestionForParent = function (completionItem: CompletionItem): void {
          const existsInYaml = proposed[completionItem.label]?.label === existingProposeItem;
          //don't put to parent suggestion if already in yaml
          if (existsInYaml) {
            return;
          }
          const schema = completionItem.parent.schema;
          const schemaType = getSchemaTypeName(schema);
          const schemaDescription = schema.markdownDescription || schema.description;

          let parentCompletion: CompletionItem | undefined = result.items.find(
            (item: CompletionItem) => item.parent?.schema === schema && item.kind === parentCompletionKind
          );

          if (parentCompletion && parentCompletion.parent.insertTexts.includes(completionItem.insertText)) {
            // already exists in the parent
            return;
          } else if (!parentCompletion) {
            // create a new parent
            parentCompletion = {
              ...completionItem,
              label: schemaType,
              documentation: schemaDescription,
              sortText: '_' + schemaType, // this parent completion goes first,
              kind: parentCompletionKind,
            };
            parentCompletion.label = parentCompletion.label || completionItem.label;
            parentCompletion.parent.insertTexts = [completionItem.insertText];
            result.items.push(parentCompletion);
          } else {
            // add to the existing parent
            parentCompletion.parent.insertTexts.push(completionItem.insertText);
          }
        };

        const isForParentCompletion = !!completionItem.parent;
        let label = completionItem.label;
        if (!label) {
          // we receive not valid CompletionItem as `label` is mandatory field, so just ignore it
          console.warn(`Ignoring CompletionItem without label: ${JSON.stringify(completionItem)}`);
          return;
        }
        if (!isString(label)) {
          label = String(label);
        }

        label = label.replace(/[\n]/g, '↵');
        if (label.length > 60) {
          const shortendedLabel = label.substr(0, 57).trim() + '...';
          if (!proposed[shortendedLabel]) {
            label = shortendedLabel;
          }
        }

        // trim $1 from end of completion
        if (completionItem.insertText.endsWith('$1') && !isForParentCompletion) {
          completionItem.insertText = completionItem.insertText.substr(0, completionItem.insertText.length - 2);
        }
        if (overwriteRange && overwriteRange.start.line === overwriteRange.end.line) {
          completionItem.textEdit = TextEdit.replace(overwriteRange, completionItem.insertText);
        }

        completionItem.label = label;

        if (isForParentCompletion) {
          addSuggestionForParent(completionItem);
          return;
        }

        if (this.arrayPrefixIndentation) {
          this.updateCompletionText(completionItem, this.arrayPrefixIndentation + completionItem.insertText);
        }

        const existing = proposed[label];
        const isInsertTextDifferent =
          existing?.label !== existingProposeItem && existing?.insertText !== completionItem.insertText;
        if (!existing) {
          proposed[label] = completionItem;
          result.items.push(completionItem);
        } else if (isInsertTextDifferent) {
          // try to merge simple insert values
          const mergedText = this.mergeSimpleInsertTexts(label, existing.insertText, completionItem.insertText, oneOfSchema);
          if (mergedText) {
            this.updateCompletionText(existing, mergedText);
          } else {
            // add to result when it wasn't able to merge (even if the item is already there but with a different value)
            proposed[label] = completionItem;
            result.items.push(completionItem);
          }
        }
        if (existing && !existing.documentation && completionItem.documentation) {
          existing.documentation = completionItem.documentation;
        }
      },
      error: (message: string) => {
        this.telemetry?.sendError('yaml.completion.error', message);
      },
      log: (message: string) => {
        console.log(message);
      },
      getNumberOfProposals: () => {
        return result.items.length;
      },
      result,
      proposed,
    };

    if (this.customTags && this.customTags.length > 0) {
      this.getCustomTagValueCompletions(collector);
    }

    if (lineContent.endsWith('\n')) {
      lineContent = lineContent.substr(0, lineContent.length - 1);
    }

    try {
      const documentUri = removeUniquePostfix(document.uri); // return back the original name to find schema
      const schema = await this.schemaService.getSchemaForResource(documentUri, currentDoc);

      if (!schema || schema.errors.length) {
        if (position.line === 0 && position.character === 0 && !isModeline(lineContent)) {
          const inlineSchemaCompletion = {
            kind: CompletionItemKind.Text,
            label: 'Inline schema',
            insertText: '# yaml-language-server: $schema=',
            insertTextFormat: InsertTextFormat.PlainText,
          };
          result.items.push(inlineSchemaCompletion);
        }
      }

      if (isModeline(lineContent) || isInComment(doc.tokens, offset)) {
        const schemaIndex = lineContent.indexOf('$schema=');
        if (schemaIndex !== -1 && schemaIndex + '$schema='.length <= position.character) {
          this.schemaService.getAllSchemas().forEach((schema) => {
            const schemaIdCompletion: CompletionItem = {
              kind: CompletionItemKind.Constant,
              label: schema.name ?? schema.uri,
              detail: schema.description,
              insertText: schema.uri,
              insertTextFormat: InsertTextFormat.PlainText,
              insertTextMode: InsertTextMode.asIs,
            };
            result.items.push(schemaIdCompletion);
          });
        }
        return result;
      }

      if (!schema || schema.errors.length) {
        return result;
      }

      let currentProperty: YamlNode = null;

      if (!node) {
        if (!currentDoc.internalDocument.contents || isScalar(currentDoc.internalDocument.contents)) {
          const map = currentDoc.internalDocument.createNode({});
          map.range = [offset, offset + 1, offset + 1];
          currentDoc.internalDocument.contents = map;
          currentDoc.updateFromInternalDocument();
          node = map;
        } else {
          node = currentDoc.findClosestNode(offset, textBuffer);
          foundByClosest = true;
        }
      }

      const originalNode = node;
      if (node) {
        if (lineContent.length === 0) {
          node = currentDoc.internalDocument.contents as Node;
        } else if (isSeq(node) && isOnlyHyphen) {
          const index = this.findItemAtOffset(node, document, offset);
          const item = node.items[index];
          if (isNode(item)) {
            node = item;
          }
        } else {
          const parent = currentDoc.getParent(node);
          if (parent) {
            if (isScalar(node)) {
              if (node.value) {
                if (isPair(parent)) {
                  if (parent.value === node) {
                    if (lineContent.trim().length > 0 && lineContent.indexOf(':') < 0) {
                      const map = this.createTempObjNode(currentWord, node, currentDoc);
                      const parentParent = currentDoc.getParent(parent);
                      if (isSeq(currentDoc.internalDocument.contents)) {
                        const index = indexOf(currentDoc.internalDocument.contents, parent);
                        if (typeof index === 'number') {
                          currentDoc.internalDocument.set(index, map);
                          currentDoc.updateFromInternalDocument();
                        }
                      } else if (parentParent && (isMap(parentParent) || isSeq(parentParent))) {
                        parentParent.set(parent.key, map);
                        currentDoc.updateFromInternalDocument();
                      } else {
                        currentDoc.internalDocument.set(parent.key, map);
                        currentDoc.updateFromInternalDocument();
                      }

                      currentProperty = (map as YAMLMap).items[0];
                      node = map;
                    } else if (lineContent.trim().length === 0) {
                      const parentParent = currentDoc.getParent(parent);
                      if (parentParent) {
                        node = parentParent;
                      }
                    }
                  } else if (parent.key === node) {
                    const parentParent = currentDoc.getParent(parent);
                    currentProperty = parent;
                    if (parentParent) {
                      node = parentParent;
                    }
                  }
                } else if (isSeq(parent)) {
                  if (lineContent.trim().length > 0) {
                    const map = this.createTempObjNode(currentWord, node, currentDoc);
                    parent.delete(node);
                    parent.add(map);
                    currentDoc.updateFromInternalDocument();
                    node = map;
                  } else {
                    node = parent;
                  }
                }
              } else if (node.value === null) {
                if (isPair(parent)) {
                  if (parent.key === node) {
                    node = parent;
                  } else {
                    if (isNode(parent.key) && parent.key.range) {
                      const parentParent = currentDoc.getParent(parent);
                      if (foundByClosest && parentParent && isMap(parentParent) && isMapContainsEmptyPair(parentParent)) {
                        node = parentParent;
                      } else {
                        const parentPosition = document.positionAt(parent.key.range[0]);
                        //if cursor has bigger indentation that parent key, then we need to complete new empty object
                        if (position.character > parentPosition.character && position.line !== parentPosition.line) {
                          const map = this.createTempObjNode(currentWord, node, currentDoc);

                          if (parentParent && (isMap(parentParent) || isSeq(parentParent))) {
                            parentParent.set(parent.key, map);
                            currentDoc.updateFromInternalDocument();
                          } else {
                            currentDoc.internalDocument.set(parent.key, map);
                            currentDoc.updateFromInternalDocument();
                          }
                          currentProperty = (map as YAMLMap).items[0];
                          node = map;
                        } else if (parentPosition.character === position.character) {
                          if (parentParent) {
                            node = parentParent;
                          }
                        }
                      }
                    }
                  }
                } else if (isSeq(parent)) {
                  if (lineContent.charAt(position.character - 1) !== '-') {
                    const map = this.createTempObjNode(currentWord, node, currentDoc);
                    parent.delete(node);
                    parent.add(map);
                    currentDoc.updateFromInternalDocument();
                    node = map;
                  } else if (lineContent.charAt(position.character - 1) === '-') {
                    const map = this.createTempObjNode('', node, currentDoc);
                    parent.delete(node);
                    parent.add(map);
                    currentDoc.updateFromInternalDocument();
                    node = map;
                  } else {
                    node = parent;
                  }
                }
              }
            } else if (isMap(node)) {
              if (!foundByClosest && lineContent.trim().length === 0 && isSeq(parent)) {
                const nextLine = textBuffer.getLineContent(position.line + 1);
                if (textBuffer.getLineCount() === position.line + 1 || nextLine.trim().length === 0) {
                  node = parent;
                }
              }
            }
          } else if (isScalar(node)) {
            const map = this.createTempObjNode(currentWord, node, currentDoc);
            currentDoc.internalDocument.contents = map;
            currentDoc.updateFromInternalDocument();
            currentProperty = map.items[0];
            node = map;
          } else if (isMap(node)) {
            for (const pair of node.items) {
              if (isNode(pair.value) && pair.value.range && pair.value.range[0] === offset + 1) {
                node = pair.value;
              }
            }
          } else if (isSeq(node)) {
            if (lineContent.charAt(position.character - 1) !== '-') {
              const map = this.createTempObjNode(currentWord, node, currentDoc);
              map.items = [];
              currentDoc.updateFromInternalDocument();
              for (const pair of node.items) {
                if (isMap(pair)) {
                  pair.items.forEach((value) => {
                    map.items.push(value);
                  });
                }
              }
              node = map;
            }
          }
        }
      }

      // completion for object keys
      if (node && isMap(node)) {
        // don't suggest properties that are already present
        const properties = node.items;
        for (const p of properties) {
          if (!currentProperty || currentProperty !== p) {
            if (isScalar(p.key)) {
              proposed[p.key.value + ''] = CompletionItemBase.create(existingProposeItem);
            }
          }
        }

        this.addPropertyCompletions(
          schema,
          currentDoc,
          node,
          originalNode,
          '',
          collector,
          textBuffer,
          overwriteRange,
          doComplete
        );

        if (!schema && currentWord.length > 0 && text.charAt(offset - currentWord.length - 1) !== '"') {
          collector.add({
            kind: CompletionItemKind.Property,
            label: currentWord,
            insertText: this.getInsertTextForProperty(currentWord, null, ''),
            insertTextFormat: InsertTextFormat.Snippet,
          });
        }
      }

      // proposals for values
      const types: { [type: string]: boolean } = {};
      this.getValueCompletions(schema, currentDoc, node, offset, document, collector, types, doComplete);
    } catch (err) {
      this.telemetry?.sendError('yaml.completion.error', err);
    }

    this.finalizeParentCompletion(result);

    const uniqueItems = result.items.filter(
      (arr, index, self) =>
        index ===
        self.findIndex((item) => item.label === arr.label && item.insertText === arr.insertText && item.kind === arr.kind)
    );

    if (uniqueItems?.length > 0) {
      result.items = uniqueItems;
    }

    return result;
  }

  updateCompletionText(completionItem: CompletionItem, text: string): void {
    completionItem.insertText = text;
    if (completionItem.textEdit) {
      completionItem.textEdit.newText = text;
    }
  }

  mergeSimpleInsertTexts(label: string, existingText: string, addingText: string, oneOfSchema: boolean): string | undefined {
    const containsNewLineAfterColon = (value: string): boolean => {
      return value.includes('\n');
    };
    const startWithNewLine = (value: string): boolean => {
      return value.startsWith('\n');
    };
    const isNullObject = (value: string): boolean => {
      const index = value.indexOf('\n');
      return index > 0 && value.substring(index, value.length).trim().length === 0;
    };
    if (containsNewLineAfterColon(existingText) || containsNewLineAfterColon(addingText)) {
      //if the exisiting object null one then replace with the non-null object
      if (oneOfSchema && isNullObject(existingText) && !isNullObject(addingText) && !startWithNewLine(addingText)) {
        return addingText;
      }
      return undefined;
    }
    const existingValues = this.getValuesFromInsertText(existingText);
    const addingValues = this.getValuesFromInsertText(addingText);

    const newValues = Array.prototype.concat(existingValues, addingValues);
    if (!newValues.length) {
      return undefined;
    } else if (newValues.length === 1) {
      return `${label}: \${1:${newValues[0]}}`;
    } else {
      return `${label}: \${1|${newValues.join(',')}|}`;
    }
  }

  getValuesFromInsertText(insertText: string): string[] {
    const value = insertText.substring(insertText.indexOf(':') + 1).trim();
    if (!value) {
      return [];
    }
    const valueMath = value.match(/^\${1[|:]([^|]*)+\|?}$/); // ${1|one,two,three|}  or  ${1:one}
    if (valueMath) {
      return valueMath[1].split(',');
    }
    return [value];
  }

  private finalizeParentCompletion(result: CompletionList): void {
    const reindexText = (insertTexts: string[]): string[] => {
      //modify added props to have unique $x
      let max$index = 0;
      return insertTexts.map((text) => {
        const match = text.match(/\$([0-9]+)|\${[0-9]+:/g);
        if (!match) {
          return text;
        }
        const max$indexLocal = match
          .map((m) => +m.replace(/\${([0-9]+)[:|]/g, '$1').replace('$', '')) // get numbers form $1 or ${1:...}
          .reduce((p, n) => (n > p ? n : p), 0); // find the max one
        const reindexedStr = text
          .replace(/\$([0-9]+)/g, (s, args) => '$' + (+args + max$index)) // increment each by max$index
          .replace(/\${([0-9]+)[:|]/g, (s, args) => '${' + (+args + max$index) + ':'); // increment each by max$index
        max$index += max$indexLocal;
        return reindexedStr;
      });
    };

    result.items.forEach((completionItem) => {
      if (isParentCompletionItem(completionItem)) {
        const indent = completionItem.parent.indent || '';

        const reindexedTexts = reindexText(completionItem.parent.insertTexts);

        // add indent to each object property and join completion item texts
        let insertText = reindexedTexts.join(`\n${indent}`);

        // trim $1 from end of completion
        if (insertText.endsWith('$1')) {
          insertText = insertText.substring(0, insertText.length - 2);
        }

        completionItem.insertText = this.arrayPrefixIndentation + insertText;
        if (completionItem.textEdit) {
          completionItem.textEdit.newText = completionItem.insertText;
        }
        // remove $x or use {$x:value} in documentation
        let mdText = insertText.replace(/\${[0-9]+[:|](.*)}/g, (s, arg) => arg).replace(/\$([0-9]+)/g, '');
        // unescape special chars for markdown, reverse operation to getInsertTextForPlainText
        mdText = getOriginalTextFromEscaped(mdText);
        const originalDocumentation = completionItem.documentation ? [completionItem.documentation, '', '----', ''] : [];
        completionItem.documentation = {
          kind: MarkupKind.Markdown,
          value: [...originalDocumentation, '```yaml', indent + mdText, '```'].join('\n'),
        };
        delete completionItem.parent;
      }
    });
  }

  private createTempObjNode(currentWord: string, node: Node, currentDoc: SingleYAMLDocument): YAMLMap {
    const obj = {};
    obj[currentWord] = null;
    const map: YAMLMap = currentDoc.internalDocument.createNode(obj) as YAMLMap;
    map.range = node.range;
    (map.items[0].key as Node).range = node.range;
    (map.items[0].value as Node).range = node.range;
    return map;
  }

  private addPropertyCompletions(
    schema: ResolvedSchema,
    doc: SingleYAMLDocument,
    node: YAMLMap,
    originalNode: YamlNode,
    separatorAfter: string,
    collector: CompletionsCollector,
    textBuffer: TextBuffer,
    overwriteRange: Range,
    doComplete: boolean
  ): void {
    const matchingSchemas = doc.getMatchingSchemas(schema.schema, -1, null, doComplete);
    const existingKey = textBuffer.getText(overwriteRange);
    const lineContent = textBuffer.getLineContent(overwriteRange.start.line);
    const hasOnlyWhitespace = lineContent.trim().length === 0;
    const hasColon = lineContent.indexOf(':') !== -1;
    const isInArray = lineContent.trimLeft().indexOf('-') === 0;
    const nodeParent = doc.getParent(node);
    const matchOriginal = matchingSchemas.find((it) => it.node.internalNode === originalNode && it.schema.properties);
    const oneOfSchema = matchingSchemas.filter((schema) => schema.schema.oneOf).map((oneOfSchema) => oneOfSchema.schema.oneOf)[0];
    let didOneOfSchemaMatches = false;
    if (oneOfSchema?.length < matchingSchemas.length) {
      oneOfSchema?.forEach((property: JSONSchema, index: number) => {
        if (!matchingSchemas[index]?.schema.oneOf && matchingSchemas[index]?.schema.properties === property.properties) {
          didOneOfSchemaMatches = true;
        }
      });
    }
    for (const schema of matchingSchemas) {
      if (schema.schema.deprecationMessage || schema.schema.doNotSuggest) {
        continue;
      }

      if (
        ((schema.node.internalNode === node && !matchOriginal) ||
          (schema.node.internalNode === originalNode && !hasColon) ||
          (schema.node.parent?.internalNode === originalNode && !hasColon)) &&
        !schema.inverted
      ) {
        this.collectDefaultSnippets(schema.schema, separatorAfter, collector, {
          newLineFirst: false,
          indentFirstObject: false,
          shouldIndentWithTab: isInArray,
        });

        const schemaProperties = schema.schema.properties;
        if (schemaProperties) {
          const maxProperties = schema.schema.maxProperties;
          if (
            maxProperties === undefined ||
            node.items === undefined ||
            node.items.length < maxProperties ||
            (node.items.length === maxProperties && !hasOnlyWhitespace)
          ) {
            for (const key in schemaProperties) {
              if (Object.prototype.hasOwnProperty.call(schemaProperties, key)) {
                const propertySchema = schemaProperties[key];

                if (typeof propertySchema === 'object' && !propertySchema.deprecationMessage && !propertySchema.doNotSuggest) {
                  let indentCompensation = '';
                  if (nodeParent && isSeq(nodeParent) && node.items.length <= 1 && !hasOnlyWhitespace) {
                    // because there is a slash '-' to prevent the properties generated to have the correct indent
                    const fromLastHyphenToPosition = lineContent.slice(
                      lineContent.lastIndexOf('-'),
                      overwriteRange.start.character
                    );
                    const hyphenFollowedByEmpty = fromLastHyphenToPosition.match(/-([ \t]*)/);
                    if (hyphenFollowedByEmpty) {
                      indentCompensation = ' ' + hyphenFollowedByEmpty[1];
                    }
                  }
                  indentCompensation += this.arrayPrefixIndentation;

                  // if check that current node has last pair with "null" value and key witch match key from schema,
                  // and if schema has array definition it add completion item for array item creation
                  let pair: Pair;
                  if (
                    propertySchema.type === 'array' &&
                    (pair = node.items.find(
                      (it) =>
                        isScalar(it.key) &&
                        it.key.range &&
                        it.key.value === key &&
                        isScalar(it.value) &&
                        !it.value.value &&
                        textBuffer.getPosition(it.key.range[2]).line === overwriteRange.end.line - 1
                    )) &&
                    pair
                  ) {
                    if (Array.isArray(propertySchema.items)) {
                      this.addSchemaValueCompletions(propertySchema.items[0], separatorAfter, collector, {}, 'property');
                    } else if (typeof propertySchema.items === 'object' && propertySchema.items.type === 'object') {
                      this.addArrayItemValueCompletion(propertySchema.items, separatorAfter, collector);
                    }
                  }

                  let insertText = key;
                  if (!key.startsWith(existingKey) || !hasColon) {
                    insertText = this.getInsertTextForProperty(
                      key,
                      propertySchema,
                      separatorAfter,
                      indentCompensation + this.indentation
                    );
                  }
                  const isNodeNull =
                    (isScalar(originalNode) && originalNode.value === null) ||
                    (isMap(originalNode) && originalNode.items.length === 0);
                  // jigx custom - exclude parent skeleton for expression completion, required prop made troubles
                  const existsParentCompletion = schema.schema.required?.length > 0 && doc.uri !== expressionSchemaName;
                  // end jigx custom
                  if (!this.parentSkeletonSelectedFirst || !isNodeNull || !existsParentCompletion) {
                    collector.add(
                      {
                        kind: CompletionItemKind.Property,
                        label: key,
                        insertText,
                        insertTextFormat: InsertTextFormat.Snippet,
                        documentation: this.fromMarkup(propertySchema.markdownDescription) || propertySchema.description || '',
                        ...(schema.schema.title ? { data: { schemaTitle: schema.schema.title } } : undefined),
                      },
                      didOneOfSchemaMatches
                    );
                  }
                  // if the prop is required add it also to parent suggestion
                  if (existsParentCompletion && schema.schema.required?.includes(key)) {
                    collector.add({
                      label: key,
                      insertText: this.getInsertTextForProperty(
                        key,
                        propertySchema,
                        separatorAfter,
                        indentCompensation + this.indentation
                      ),
                      insertTextFormat: InsertTextFormat.Snippet,
                      documentation: this.fromMarkup(propertySchema.markdownDescription) || propertySchema.description || '',
                      parent: {
                        schema: schema.schema,
                        indent: indentCompensation,
                      },
                    });
                  }
                }
              }
            }
          }
        }
        // Error fix
        // If this is a array of string/boolean/number
        //  test:
        //    - item1
        // it will treated as a property key since `:` has been appended
        if (nodeParent && isSeq(nodeParent) && isPrimitiveType(schema.schema)) {
          this.addSchemaValueCompletions(
            schema.schema,
            separatorAfter,
            collector,
            {},
            'property',
            Array.isArray(nodeParent.items) && !isInArray
          );
        }

        if (schema.schema.propertyNames && schema.schema.additionalProperties && schema.schema.type === 'object') {
          const propertyNameSchema = asSchema(schema.schema.propertyNames);
          const label = propertyNameSchema.title || 'property';
          collector.add({
            kind: CompletionItemKind.Property,
            label,
            insertText: '$' + `{1:${label}}: `,
            insertTextFormat: InsertTextFormat.Snippet,
            documentation: this.fromMarkup(propertyNameSchema.markdownDescription) || propertyNameSchema.description || '',
          });
        }
      }

      if (nodeParent && schema.node.internalNode === nodeParent && schema.schema.defaultSnippets) {
        // For some reason the first item in the array needs to be treated differently, otherwise
        // the indentation will not be correct
        if (node.items.length === 1) {
          this.collectDefaultSnippets(
            schema.schema,
            separatorAfter,
            collector,
            {
              newLineFirst: false,
              indentFirstObject: false,
              shouldIndentWithTab: true,
            },
            1
          );
        } else {
          this.collectDefaultSnippets(
            schema.schema,
            separatorAfter,
            collector,
            {
              newLineFirst: false,
              indentFirstObject: true,
              shouldIndentWithTab: false,
            },
            1
          );
        }
      }
    }
  }

  private getValueCompletions(
    schema: ResolvedSchema,
    doc: SingleYAMLDocument,
    node: YamlNode,
    offset: number,
    document: TextDocument,
    collector: CompletionsCollector,
    types: { [type: string]: boolean },
    doComplete: boolean
  ): void {
    let parentKey: string = null;

    if (node && isScalar(node)) {
      node = doc.getParent(node);
    }

    if (!node) {
      this.addSchemaValueCompletions(schema.schema, '', collector, types, 'value');
      return;
    }

    if (isPair(node)) {
      const valueNode: Node = node.value as Node;
      if (valueNode && valueNode.range && offset > valueNode.range[0] + valueNode.range[2]) {
        return; // we are past the value node
      }
      parentKey = isScalar(node.key) ? node.key.value + '' : null;
      node = doc.getParent(node);
    }

    if (node && (parentKey !== null || isSeq(node))) {
      const separatorAfter = '';
      const matchingSchemas = doc.getMatchingSchemas(schema.schema, -1, null, doComplete);
      for (const s of matchingSchemas) {
        if (s.node.internalNode === node && !s.inverted && s.schema) {
          if (s.schema.items) {
            this.collectDefaultSnippets(s.schema, separatorAfter, collector, {
              newLineFirst: false,
              indentFirstObject: false,
              shouldIndentWithTab: false,
            });
            if (isSeq(node) && node.items) {
              if (Array.isArray(s.schema.items)) {
                const index = this.findItemAtOffset(node, document, offset);
                if (index < s.schema.items.length) {
                  this.addSchemaValueCompletions(s.schema.items[index], separatorAfter, collector, types, 'value');
                }
              } else {
                this.addSchemaValueCompletions(s.schema.items, separatorAfter, collector, types, 'value', true);
              }
            }
          }
          if (s.schema.properties) {
            const propertySchema = s.schema.properties[parentKey];
            if (propertySchema) {
              this.addSchemaValueCompletions(propertySchema, separatorAfter, collector, types, 'value');
            }
          }
          if (s.schema.additionalProperties) {
            this.addSchemaValueCompletions(s.schema.additionalProperties, separatorAfter, collector, types, 'value');
          }
        }
      }

      if (types['boolean']) {
        this.addBooleanValueCompletion(true, separatorAfter, collector);
        this.addBooleanValueCompletion(false, separatorAfter, collector);
      }
      if (types['null']) {
        this.addNullValueCompletion(separatorAfter, collector);
      }
    }
  }

  private addArrayItemValueCompletion(
    schema: JSONSchema,
    separatorAfter: string,
    collector: CompletionsCollector,
    index?: number
  ): void {
    const schemaType = getSchemaTypeName(schema);
    const insertText = `- ${this.getInsertTextForObject(schema, separatorAfter).insertText.trimLeft()}`;
    //append insertText to documentation
    const schemaTypeTitle = schemaType ? ' type `' + schemaType + '`' : '';
    const schemaDescription = schema.description ? ' (' + schema.description + ')' : '';
    const documentation = this.getDocumentationWithMarkdownText(
      `Create an item of an array${schemaTypeTitle}${schemaDescription}`,
      insertText
    );
    collector.add({
      kind: this.getSuggestionKind(schema.type),
      label: '- (array item) ' + ((schemaType || index) ?? ''),
      documentation: documentation,
      insertText: insertText,
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }

  private getInsertTextForProperty(
    key: string,
    propertySchema: JSONSchema,
    separatorAfter: string,
    indent = this.indentation
  ): string {
    const propertyText = this.getInsertTextForValue(key, '', 'string');
    const resultText = propertyText + ':';

    let value: string;
    let nValueProposals = 0;
    if (propertySchema) {
      let type = Array.isArray(propertySchema.type) ? propertySchema.type[0] : propertySchema.type;
      if (!type) {
        if (propertySchema.properties) {
          type = 'object';
        } else if (propertySchema.items) {
          type = 'array';
        } else if (propertySchema.anyOf) {
          type = 'anyOf';
        }
      }
      if (Array.isArray(propertySchema.defaultSnippets)) {
        if (propertySchema.defaultSnippets.length === 1) {
          const body = propertySchema.defaultSnippets[0].body;
          if (isDefined(body)) {
            value = this.getInsertTextForSnippetValue(
              body,
              '',
              {
                newLineFirst: true,
                indentFirstObject: false,
                shouldIndentWithTab: false,
              },
              [],
              1
            );
            // add space before default snippet value
            if (!value.startsWith(' ') && !value.startsWith('\n')) {
              value = ' ' + value;
            }
          }
        }
        nValueProposals += propertySchema.defaultSnippets.length;
      }
      if (propertySchema.enum) {
        if (!value && propertySchema.enum.length === 1) {
          value = ' ' + this.getInsertTextForGuessedValue(propertySchema.enum[0], '', type);
        }
        nValueProposals += propertySchema.enum.length;
      }

      if (propertySchema.const) {
        if (!value) {
          value = this.getInsertTextForGuessedValue(propertySchema.const, '', type);
          value = evaluateTab1Symbol(value); // prevent const being selected after snippet insert
          value = ' ' + value;
        }
        nValueProposals++;
      }

      if (isDefined(propertySchema.default)) {
        if (!value) {
          value = ' ' + this.getInsertTextForGuessedValue(propertySchema.default, '', type);
        }
        nValueProposals++;
      }
      if (Array.isArray(propertySchema.examples) && propertySchema.examples.length) {
        if (!value) {
          value = ' ' + this.getInsertTextForGuessedValue(propertySchema.examples[0], '', type);
        }
        nValueProposals += propertySchema.examples.length;
      }
      if (propertySchema.properties) {
        return `${resultText}\n${this.getInsertTextForObject(propertySchema, separatorAfter, indent).insertText}`;
      } else if (propertySchema.items) {
        return `${resultText}\n${indent}- ${
          this.getInsertTextForArray(propertySchema.items, separatorAfter, 1, indent).insertText
        }`;
      }
      if (nValueProposals === 0) {
        switch (type) {
          case 'boolean':
            value = ' $1';
            break;
          case 'string':
            value = ' $1';
            break;
          case 'object':
            value = `\n${indent}`;
            break;
          case 'array':
            value = `\n${indent}- `;
            break;
          case 'number':
          case 'integer':
            value = ' ${1:0}';
            break;
          case 'null':
            value = ' ${1:null}';
            break;
          case 'anyOf':
            value = ' $1';
            break;
          default:
            return propertyText;
        }
      }
    }
    if (!value || nValueProposals > 1) {
      value = ' $1';
    }
    return resultText + value + separatorAfter;
  }

  private getInsertTextForObject(
    schema: JSONSchema,
    separatorAfter: string,
    indent = this.indentation,
    insertIndex = 1
  ): InsertText {
    let insertText = '';
    if (!schema.properties) {
      insertText = `${indent}$${insertIndex++}\n`;
      return { insertText, insertIndex };
    }

    Object.keys(schema.properties).forEach((key: string) => {
      const propertySchema = schema.properties[key] as JSONSchema;
      const keyEscaped = getInsertTextForPlainText(key);
      let type = Array.isArray(propertySchema.type) ? propertySchema.type[0] : propertySchema.type;
      if (!type) {
        if (propertySchema.anyOf) {
          type = 'anyOf';
        }
        if (propertySchema.properties) {
          type = 'object';
        }
        if (propertySchema.items) {
          type = 'array';
        }
      }
      if (schema.required && schema.required.indexOf(key) > -1) {
        switch (type) {
          case 'boolean':
          case 'string':
          case 'number':
          case 'integer':
          case 'anyOf': {
            let value = propertySchema.default === undefined ? propertySchema.const : propertySchema.default;
            if (isDefined(value)) {
              if (type === 'string' || typeof value === 'string') {
                value = convertToStringValue(value);
              }
              insertText += `${indent}${keyEscaped}: \${${insertIndex++}:${value}}\n`;
            } else {
              insertText += `${indent}${keyEscaped}: $${insertIndex++}\n`;
            }
            break;
          }
          case 'array':
            {
              const arrayInsertResult = this.getInsertTextForArray(propertySchema.items, separatorAfter, insertIndex++, indent);
              const arrayInsertLines = arrayInsertResult.insertText.split('\n');
              let arrayTemplate = arrayInsertResult.insertText;
              if (arrayInsertLines.length > 1) {
                for (let index = 1; index < arrayInsertLines.length; index++) {
                  const element = arrayInsertLines[index];
                  arrayInsertLines[index] = `  ${element}`;
                }
                arrayTemplate = arrayInsertLines.join('\n');
              }
              insertIndex = arrayInsertResult.insertIndex;
              insertText += `${indent}${keyEscaped}:\n${indent}${this.indentation}- ${arrayTemplate}\n`;
            }
            break;
          case 'object':
            {
              const objectInsertResult = this.getInsertTextForObject(
                propertySchema,
                separatorAfter,
                `${indent}${this.indentation}`,
                insertIndex++
              );
              insertIndex = objectInsertResult.insertIndex;
              insertText += `${indent}${keyEscaped}:\n${objectInsertResult.insertText}\n`;
            }
            break;
        }
      } else if (!this.disableDefaultProperties && propertySchema.default !== undefined) {
        switch (type) {
          case 'boolean':
          case 'number':
          case 'integer':
            insertText += `${indent}${
              //added quote if key is null
              key === 'null' ? this.getInsertTextForValue(key, '', 'string') : key
            }: \${${insertIndex++}:${propertySchema.default}}\n`;
            break;
          case 'string':
            insertText += `${indent}${keyEscaped}: \${${insertIndex++}:${convertToStringValue(propertySchema.default)}}\n`;
            break;
          case 'array':
          case 'object':
            // TODO: support default value for array object
            break;
        }
      }
    });
    if (insertText.trim().length === 0) {
      insertText = `${indent}$${insertIndex++}\n`;
    }
    insertText = insertText.trimRight() + separatorAfter;
    return { insertText, insertIndex };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getInsertTextForArray(schema: any, separatorAfter: string, insertIndex = 1, indent = this.indentation): InsertText {
    let insertText = '';
    if (!schema) {
      insertText = `$${insertIndex++}`;
      return { insertText, insertIndex };
    }
    let type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (!type) {
      if (schema.properties) {
        type = 'object';
      }
      if (schema.items) {
        type = 'array';
      }
    }
    switch (schema.type) {
      case 'boolean':
        insertText = `\${${insertIndex++}:false}`;
        break;
      case 'number':
      case 'integer':
        insertText = `\${${insertIndex++}:0}`;
        break;
      case 'string':
        insertText = `\${${insertIndex++}}`;
        break;
      case 'object':
        {
          const objectInsertResult = this.getInsertTextForObject(schema, separatorAfter, `${indent}  `, insertIndex++);
          insertText = objectInsertResult.insertText.trimLeft();
          insertIndex = objectInsertResult.insertIndex;
        }
        break;
    }
    return { insertText, insertIndex };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getInsertTextForGuessedValue(value: any, separatorAfter: string, type: string): string {
    switch (typeof value) {
      case 'object':
        if (value === null) {
          return '${1:null}' + separatorAfter;
        }
        return this.getInsertTextForValue(value, separatorAfter, type);
      case 'string': {
        let snippetValue = JSON.stringify(value);
        snippetValue = snippetValue.substr(1, snippetValue.length - 2); // remove quotes
        snippetValue = getInsertTextForPlainText(snippetValue); // escape \ and }
        if (type === 'string') {
          snippetValue = convertToStringValue(snippetValue);
        }
        return '${1:' + snippetValue + '}' + separatorAfter;
      }
      case 'number':
      case 'boolean':
        return '${1:' + value + '}' + separatorAfter;
    }
    return this.getInsertTextForValue(value, separatorAfter, type);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getInsertTextForValue(value: any, separatorAfter: string, type: string | string[]): string {
    if (value === null) {
      return 'null'; // replace type null with string 'null'
    }
    switch (typeof value) {
      case 'object': {
        const indent = this.indentation;
        return this.getInsertTemplateForValue(value, indent, { index: 1 }, separatorAfter);
      }
      case 'number':
      case 'boolean':
        return getInsertTextForPlainText(value + separatorAfter);
    }
    type = Array.isArray(type) ? type[0] : type;
    if (type === 'string') {
      value = convertToStringValue(value);
    }
    return getInsertTextForPlainText(value + separatorAfter);
  }

  private getInsertTemplateForValue(
    value: unknown | [],
    indent: string,
    navOrder: { index: number },
    separatorAfter: string
  ): string {
    if (Array.isArray(value)) {
      let insertText = '\n';
      for (const arrValue of value) {
        if (typeof arrValue === 'object') {
          const objectText = this.getInsertTemplateForValue(arrValue, indent, { ...navOrder }, separatorAfter);
          insertText += convertObjectToArrayItem(objectText, indent);
        } else {
          insertText += `${indent}- \${${navOrder.index++}:${arrValue}}\n`;
        }
      }
      return insertText;
    } else if (typeof value === 'object') {
      let insertText = '\n';
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          const element = value[key];
          insertText += `${indent}\${${navOrder.index++}:${key}}:`;
          let valueTemplate;
          if (typeof element === 'object') {
            valueTemplate = `${this.getInsertTemplateForValue(element, indent + this.indentation, navOrder, separatorAfter)}`;
          } else {
            valueTemplate = ` \${${navOrder.index++}:${getInsertTextForPlainText(element + separatorAfter)}}\n`;
          }
          insertText += `${valueTemplate}`;
        }
      }
      return insertText;
    }
    return getInsertTextForPlainText(value + separatorAfter);
  }

  private addSchemaValueCompletions(
    schema: JSONSchemaRef,
    separatorAfter: string,
    collector: CompletionsCollector,
    types: unknown,
    completionType: 'property' | 'value',
    isArray?: boolean
  ): void {
    if (typeof schema === 'object') {
      if (schema.deprecationMessage || schema.doNotSuggest) {
        return;
      }

      this.addEnumValueCompletions(schema, separatorAfter, collector, isArray);
      this.addDefaultValueCompletions(schema, separatorAfter, collector, 0, isArray);
      this.collectTypes(schema, types);

      if (isArray && completionType === 'value' && !isAnyOfAllOfOneOfType(schema)) {
        // add array only for final types (no anyOf, allOf, oneOf)
        this.addArrayItemValueCompletion(schema, separatorAfter, collector);
      }

      if (Array.isArray(schema.allOf)) {
        schema.allOf.forEach((s) => {
          return this.addSchemaValueCompletions(s, separatorAfter, collector, types, completionType, isArray);
        });
      }
      if (Array.isArray(schema.anyOf)) {
        schema.anyOf.forEach((s) => {
          return this.addSchemaValueCompletions(s, separatorAfter, collector, types, completionType, isArray);
        });
      }
      if (Array.isArray(schema.oneOf)) {
        schema.oneOf.forEach((s) => {
          return this.addSchemaValueCompletions(s, separatorAfter, collector, types, completionType, isArray);
        });
      }
    }
  }

  private collectTypes(schema: JSONSchema, types: unknown): void {
    if (Array.isArray(schema.enum) || isDefined(schema.const)) {
      return;
    }
    const type = schema.type;
    if (Array.isArray(type)) {
      type.forEach(function (t) {
        return (types[t] = true);
      });
    } else if (type) {
      types[type] = true;
    }
  }

  private addDefaultValueCompletions(
    schema: JSONSchema,
    separatorAfter: string,
    collector: CompletionsCollector,
    arrayDepth = 0,
    isArray?: boolean
  ): void {
    let hasProposals = false;
    if (isDefined(schema.default)) {
      let type = schema.type;
      let value = schema.default;
      for (let i = arrayDepth; i > 0; i--) {
        value = [value];
        type = 'array';
      }
      let label;
      if (typeof value == 'object') {
        label = 'Default value';
      } else {
        label = (value as unknown).toString().replace(doubleQuotesEscapeRegExp, '"');
      }
      collector.add({
        kind: this.getSuggestionKind(type),
        label,
        insertText: this.getInsertTextForValue(value, separatorAfter, type),
        insertTextFormat: InsertTextFormat.Snippet,
        detail: localize('json.suggest.default', 'Default value'),
      });
      hasProposals = true;
    }
    if (Array.isArray(schema.examples)) {
      schema.examples.forEach((example) => {
        let type = schema.type;
        let value = example;
        for (let i = arrayDepth; i > 0; i--) {
          value = [value];
          type = 'array';
        }
        collector.add({
          kind: this.getSuggestionKind(type),
          label: this.getLabelForValue(value),
          insertText: this.getInsertTextForValue(value, separatorAfter, type),
          insertTextFormat: InsertTextFormat.Snippet,
        });
        hasProposals = true;
      });
    }

    this.collectDefaultSnippets(
      schema,
      separatorAfter,
      collector,
      {
        newLineFirst: !isArray,
        indentFirstObject: !isArray,
        shouldIndentWithTab: !isArray,
      },
      0,
      isArray
    );
    if (!hasProposals && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      this.addDefaultValueCompletions(schema.items, separatorAfter, collector, arrayDepth + 1);
    }
  }

  private addEnumValueCompletions(
    schema: JSONSchema,
    separatorAfter: string,
    collector: CompletionsCollector,
    isArray: boolean
  ): void {
    if (isDefined(schema.const) && !isArray) {
      collector.add({
        kind: this.getSuggestionKind(schema.type),
        label: this.getLabelForValue(schema.const),
        insertText: this.getInsertTextForValue(schema.const, separatorAfter, schema.type),
        insertTextFormat: InsertTextFormat.Snippet,
        documentation: this.fromMarkup(schema.markdownDescription) || schema.description,
      });
    }
    if (Array.isArray(schema.enum)) {
      for (let i = 0, length = schema.enum.length; i < length; i++) {
        const enm = schema.enum[i];
        let documentation = this.fromMarkup(schema.markdownDescription) || schema.description;
        if (schema.markdownEnumDescriptions && i < schema.markdownEnumDescriptions.length && this.doesSupportMarkdown()) {
          documentation = this.fromMarkup(schema.markdownEnumDescriptions[i]);
        } else if (schema.enumDescriptions && i < schema.enumDescriptions.length) {
          documentation = schema.enumDescriptions[i];
        }
        const insertText = (isArray ? '- ' : '') + this.getInsertTextForValue(enm, separatorAfter, schema.type);
        collector.add({
          kind: this.getSuggestionKind(schema.type),
          label: this.getLabelForValue(enm),
          insertText,
          insertTextFormat: InsertTextFormat.Snippet,
          documentation: documentation,
        });
      }
    }
  }

  private getLabelForValue(value: unknown): string {
    if (value === null) {
      return 'null'; // return string with 'null' value if schema contains null as possible value
    }
    if (Array.isArray(value)) {
      return JSON.stringify(value);
    }
    return '' + value;
  }

  private collectDefaultSnippets(
    schema: JSONSchema,
    separatorAfter: string,
    collector: CompletionsCollector,
    settings: StringifySettings,
    arrayDepth = 0,
    isArray = false
  ): void {
    if (Array.isArray(schema.defaultSnippets)) {
      for (const s of schema.defaultSnippets) {
        let type = schema.type;
        let value = s.body;
        let label = s.label;
        let insertText: string;
        let filterText: string;
        if (isDefined(value)) {
          const type = s.type || schema.type;
          if ((arrayDepth === 0 && type === 'array') || isArray) {
            // We know that a - isn't present yet so we need to add one
            const fixedObj = {};
            Object.keys(value).forEach((val, index) => {
              if (index === 0 && !val.startsWith('-')) {
                fixedObj[`- ${val}`] = value[val];
              } else {
                fixedObj[`  ${val}`] = value[val];
              }
            });
            value = fixedObj;
          }
          const existingProps = Object.keys(collector.proposed).filter(
            (proposedProp) => collector.proposed[proposedProp].label === existingProposeItem
          );
          insertText = this.getInsertTextForSnippetValue(value, separatorAfter, settings, existingProps);

          // if snippet result is empty and value has a real value, don't add it as a completion
          if (insertText === '' && value) {
            continue;
          }
          label = label || this.getLabelForSnippetValue(value);
        } else if (typeof s.bodyText === 'string') {
          let prefix = '',
            suffix = '',
            indent = '';
          for (let i = arrayDepth; i > 0; i--) {
            prefix = prefix + indent + '[\n';
            suffix = suffix + '\n' + indent + ']';
            indent += this.indentation;
            type = 'array';
          }
          insertText = prefix + indent + s.bodyText.split('\n').join('\n' + indent) + suffix + separatorAfter;
          label = label || insertText;
          filterText = insertText.replace(/[\n]/g, ''); // remove new lines
        }
        collector.add({
          kind: s.suggestionKind || this.getSuggestionKind(type),
          label,
          sortText: s.sortText || s.label,
          documentation: this.fromMarkup(s.markdownDescription) || s.description,
          insertText,
          insertTextFormat: InsertTextFormat.Snippet,
          filterText,
        });
      }
    }
  }

  private getInsertTextForSnippetValue(
    value: unknown,
    separatorAfter: string,
    settings: StringifySettings,
    existingProps: string[],
    depth?: number
  ): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replacer = (value: unknown): string | any => {
      if (typeof value === 'string') {
        if (value[0] === '^') {
          return value.substr(1);
        }
        if (value === 'true' || value === 'false') {
          return `"${value}"`;
        }
      }
      return value;
    };
    return (
      stringifyObject(value, '', replacer, { ...settings, indentation: this.indentation, existingProps }, depth) + separatorAfter
    );
  }

  private addBooleanValueCompletion(value: boolean, separatorAfter: string, collector: CompletionsCollector): void {
    collector.add({
      kind: this.getSuggestionKind('boolean'),
      label: value ? 'true' : 'false',
      insertText: this.getInsertTextForValue(value, separatorAfter, 'boolean'),
      insertTextFormat: InsertTextFormat.Snippet,
      documentation: '',
    });
  }

  private addNullValueCompletion(separatorAfter: string, collector: CompletionsCollector): void {
    collector.add({
      kind: this.getSuggestionKind('null'),
      label: 'null',
      insertText: 'null' + separatorAfter,
      insertTextFormat: InsertTextFormat.Snippet,
      documentation: '',
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getLabelForSnippetValue(value: any): string {
    const label = JSON.stringify(value);
    return label.replace(/\$\{\d+:([^}]+)\}|\$\d+/g, '$1');
  }

  private getCustomTagValueCompletions(collector: CompletionsCollector): void {
    const validCustomTags = filterInvalidCustomTags(this.customTags);
    validCustomTags.forEach((validTag) => {
      // Valid custom tags are guarenteed to be strings
      const label = validTag.split(' ')[0];
      this.addCustomTagValueCompletion(collector, ' ', label);
    });
  }

  private addCustomTagValueCompletion(collector: CompletionsCollector, separatorAfter: string, label: string): void {
    collector.add({
      kind: this.getSuggestionKind('string'),
      label: label,
      insertText: label + separatorAfter,
      insertTextFormat: InsertTextFormat.Snippet,
      documentation: '',
    });
  }

  private getDocumentationWithMarkdownText(documentation: string, insertText: string): string | MarkupContent {
    let res: string | MarkupContent = documentation;
    if (this.doesSupportMarkdown()) {
      insertText = insertText
        .replace(/\${[0-9]+[:|](.*)}/g, (s, arg) => {
          return arg;
        })
        .replace(/\$([0-9]+)/g, '');
      res = this.fromMarkup(`${documentation}\n \`\`\`\n${insertText}\n\`\`\``) as MarkupContent;
    }
    return res;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getSuggestionKind(type: any): CompletionItemKind {
    if (Array.isArray(type)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const array = <any[]>type;
      type = array.length > 0 ? array[0] : null;
    }
    if (!type) {
      return CompletionItemKind.Value;
    }
    switch (type) {
      case 'string':
        return CompletionItemKind.Value;
      case 'object':
        return CompletionItemKind.Module;
      case 'property':
        return CompletionItemKind.Property;
      default:
        return CompletionItemKind.Value;
    }
  }

  private getCurrentWord(doc: TextDocument, offset: number): string {
    let i = offset - 1;
    const text = doc.getText();
    while (i >= 0 && ' \t\n\r\v":{[,]}'.indexOf(text.charAt(i)) === -1) {
      i--;
    }
    return text.substring(i + 1, offset);
  }

  private fromMarkup(markupString: string): MarkupContent | undefined {
    if (markupString && this.doesSupportMarkdown()) {
      return {
        kind: MarkupKind.Markdown,
        value: markupString,
      };
    }
    return undefined;
  }

  private doesSupportMarkdown(): boolean {
    if (this.supportsMarkdown === undefined) {
      const completion = this.clientCapabilities.textDocument && this.clientCapabilities.textDocument.completion;
      this.supportsMarkdown =
        completion &&
        completion.completionItem &&
        Array.isArray(completion.completionItem.documentationFormat) &&
        completion.completionItem.documentationFormat.indexOf(MarkupKind.Markdown) !== -1;
    }
    return this.supportsMarkdown;
  }

  private findItemAtOffset(seqNode: YAMLSeq, doc: TextDocument, offset: number): number {
    for (let i = seqNode.items.length - 1; i >= 0; i--) {
      const node = seqNode.items[i];
      if (isNode(node)) {
        if (node.range) {
          if (offset > node.range[1]) {
            return i;
          } else if (offset >= node.range[0]) {
            return i;
          }
        }
      }
    }

    return 0;
  }
}

/**
 * escape $, \ and }
 */
function getInsertTextForPlainText(text: string): string {
  return text.replace(/(\\?)([\\$}])/g, (match, escapeChar, specialChar) => {
    // If it's already escaped (has a backslash before it), return it as is
    return escapeChar ? match : `\\${specialChar}`;
  });
}

function getOriginalTextFromEscaped(text: string): string {
  return text.replace(/\\([\\$}])/g, '$1');
}

const isNumberExp = /^\d+$/;
function convertToStringValue(param: unknown): string {
  let value: string;
  if (typeof param === 'string') {
    value = param;
  } else {
    value = '' + param;
  }
  if (value.length === 0) {
    return value;
  }

  value = getInsertTextForPlainText(value); // escape $, \ and }

  if (value === 'true' || value === 'false' || value === 'null' || isNumberExp.test(value)) {
    return `"${value}"`;
  }

  if (value.indexOf('"') !== -1) {
    value = value.replace(doubleQuotesEscapeRegExp, '"');
  }

  let doQuote = !isNaN(parseInt(value)) || value.charAt(0) === '@';

  if (!doQuote) {
    // need to quote value if in `foo: bar`, `foo : bar` (mapping) or `foo:` (partial map) format
    // but `foo:bar` and `:bar` (colon without white-space after it) are just plain string
    let idx = value.indexOf(':', 0);
    for (; idx > 0 && idx < value.length; idx = value.indexOf(':', idx + 1)) {
      if (idx === value.length - 1) {
        // `foo:` (partial map) format
        doQuote = true;
        break;
      }

      // there are only two valid kinds of white-space in yaml: space or tab
      // ref: https://yaml.org/spec/1.2.1/#id2775170
      const nextChar = value.charAt(idx + 1);
      if (nextChar === '\t' || nextChar === ' ') {
        doQuote = true;
        break;
      }
    }
  }

  if (doQuote) {
    value = `"${value}"`;
  }

  return value;
}

/**
 * simplify `{$1:value}` to `value`
 */
function evaluateTab1Symbol(value: string): string {
  return value.replace(/\$\{1:(.*)\}/, '$1');
}

function isParentCompletionItem(item: CompletionItemBase): item is CompletionItem {
  return 'parent' in item;
}

export function addUniquePostfix(uri: string): string {
  return uri.replace(/(^|\/)([^./]+\.\w+)$/, `$1_tmp_${Math.random().toString(36).substring(2)}/$2`);
}

export function removeUniquePostfix(uri: string): string {
  return uri.replace(/(^|\/)_tmp_[0-9a-z]+\//, '$1');
}

export function convertObjectToArrayItem(objectText: string, indent: string): string {
  const objectItem = objectText.replace(/^(\s+)/gm, (match, _, index) => {
    // first line can contains newLine, so use indent from input parameter
    return index === 0 ? `${indent}- ` : `${match}  `;
  });
  return objectItem;
}
