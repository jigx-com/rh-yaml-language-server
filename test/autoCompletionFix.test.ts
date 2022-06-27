/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionItemKind, CompletionList, InsertTextFormat, Position, Range } from 'vscode-languageserver-types';
import { LanguageHandlers } from '../src/languageserver/handlers/languageHandlers';
import { LanguageService } from '../src/languageservice/yamlLanguageService';
import { SettingsState, TextDocumentTestManager } from '../src/yamlSettings';
import { ServiceSetup } from './utils/serviceSetup';
import { SCHEMA_ID, setupLanguageService, setupSchemaIDTextDocument } from './utils/testHelper';
import { expect } from 'chai';
import { createExpectedCompletion } from './utils/verifyError';
import * as path from 'path';
import { JSONSchema } from './../src/languageservice/jsonSchema';

describe('Auto Completion Fix Tests', () => {
  let languageSettingsSetup: ServiceSetup;
  let languageService: LanguageService;
  let languageHandler: LanguageHandlers;
  let yamlSettings: SettingsState;

  before(() => {
    languageSettingsSetup = new ServiceSetup().withCompletion().withSchemaFileMatch({
      uri: 'https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/v1.22.4-standalone-strict/all.json',
      fileMatch: [SCHEMA_ID],
    });
    const { languageService: langService, languageHandler: langHandler, yamlSettings: settings } = setupLanguageService(
      languageSettingsSetup.languageSettings
    );
    languageService = langService;
    languageHandler = langHandler;
    yamlSettings = settings;
  });

  /**
   *
   * @param content
   * @param line starts with 0 index
   * @param character starts with 1 index
   * @returns
   */
  function parseSetup(content: string, line: number, character: number): Promise<CompletionList> {
    const testTextDocument = setupSchemaIDTextDocument(content);
    yamlSettings.documents = new TextDocumentTestManager();
    (yamlSettings.documents as TextDocumentTestManager).set(testTextDocument);
    return languageHandler.completionHandler({
      position: Position.create(line, character),
      textDocument: testTextDocument,
    });
  }

  afterEach(() => {
    languageService.deleteSchema(SCHEMA_ID);
    languageService.configure(languageSettingsSetup.languageSettings);
  });

  it('should show completion on map under array', async () => {
    languageService.addSchema(SCHEMA_ID, {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: {
            type: 'object',
            properties: {
              foo: {
                type: 'boolean',
              },
            },
          },
        },
      },
    });
    const content = '- from:\n    ';
    const completion = await parseSetup(content, 1, 3);
    expect(completion.items).lengthOf(1);
    expect(completion.items[0]).eql(
      createExpectedCompletion('foo', 'foo: ', 1, 3, 1, 4, 10, 2, {
        documentation: '',
      })
    );
  });

  it('should show completion on array empty array item', async () => {
    languageService.addSchema(SCHEMA_ID, {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: {
            type: 'object',
            properties: {
              foo: {
                type: 'boolean',
              },
            },
          },
        },
      },
    });
    const content = '- ';
    const completion = await parseSetup(content, 0, 2);
    expect(completion.items).lengthOf(1);
    expect(completion.items[0]).eql(
      createExpectedCompletion('from', 'from:\n    ', 0, 2, 0, 2, 10, 2, {
        documentation: '',
      })
    );
  });

  it('should show completion items in the middle of map in array', async () => {
    const content = `apiVersion: v1
kind: Pod
metadata:
  name: foo
spec:
  containers:
    - name: test
      
      image: alpine
    `;
    const completion = await parseSetup(content, 7, 6);
    expect(completion.items).length.greaterThan(1);
  });

  it('should show completion on array item on first line', async () => {
    const content = '-d';
    const completion = await parseSetup(content, 0, 1);
    expect(completion.items).is.empty;
  });

  it('should complete without error on map inside array', async () => {
    const content = '- foo\n- bar:\n    so';
    const completion = await parseSetup(content, 2, 6);
    expect(completion.items).is.empty;
  });

  it('should complete  array', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const schema = require(path.join(__dirname, './fixtures/test-nested-object-array.json'));
    languageService.addSchema(SCHEMA_ID, schema);
    const content = `objA:
  - name: nameA1
      
objB:
  size: midle
  name: nameB2  
`;
    const completion = await parseSetup(content, 2, 4);
    expect(completion.items).is.not.empty;
  });

  it('should complete array item for "oneOf" schema', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const schema = require(path.join(__dirname, './fixtures/test-completion-oneOf.json'));
    languageService.addSchema(SCHEMA_ID, schema);
    const content = `metadata:
  Selector:
    query:
      - 
`;
    const completion = await parseSetup(content, 3, 8);
    expect(completion.items).length(5);
    expect(completion.items.map((it) => it.label)).to.have.members(['NOT', 'attribute', 'operation', 'value', 'FUNC_item']);
  });

  it('Autocomplete with short nextLine - nested object', async () => {
    languageService.addSchema(SCHEMA_ID, {
      type: 'object',
      properties: {
        example: {
          type: 'object',
          properties: {
            sample: {
              type: 'object',
              properties: {
                detail: {
                  type: 'object',
                },
              },
            },
          },
        },
        a: {
          type: 'string',
          description: 'short prop name because of distance to the cursor',
        },
      },
    });
    const content = 'example:\n  sample:\n    ';
    const completion = await parseSetup(content + '\na: test', 2, 4);
    expect(completion.items.length).equal(1);
    expect(completion.items[0]).to.be.deep.equal(
      createExpectedCompletion('detail', 'detail:\n  ', 2, 4, 2, 4, 10, 2, {
        documentation: '',
      })
    );
  });

  it('Autocomplete with a new line inside the object', async () => {
    languageService.addSchema(SCHEMA_ID, {
      type: 'object',
      properties: {
        example: {
          type: 'object',
          properties: {
            sample: {
              type: 'object',
              properties: {
                prop1: {
                  type: 'string',
                },
                prop2: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
    });
    const content = 'example:\n  sample:\n    \n    prop2: value2';
    const completion = await parseSetup(content, 2, 4);
    expect(completion.items.length).equal(1);
    expect(completion.items[0]).to.be.deep.equal(
      createExpectedCompletion('prop1', 'prop1: ', 2, 4, 2, 4, 10, 2, {
        documentation: '',
      })
    );
  });

  it('Autocomplete on the first array item', async () => {
    languageService.addSchema(SCHEMA_ID, {
      type: 'object',
      properties: {
        examples: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sample: {
                type: 'object',
                properties: {
                  prop1: {
                    type: 'string',
                  },
                },
              },
            },
          },
        },
      },
    });
    const content = 'examples:\n  \n  - sample:\n      prop1: value1';
    const completion = await parseSetup(content, 1, 2);
    expect(completion.items.length).equal(1);
    expect(completion.items[0]).to.be.deep.equal(
      createExpectedCompletion('- (array item)', '- ', 1, 2, 1, 2, 9, 2, {
        documentation: {
          kind: 'markdown',
          value: 'Create an item of an array\n ```\n- \n```',
        },
      })
    );
  });

  it('Array of enum autocomplete of irregular order', async () => {
    languageService.addSchema(SCHEMA_ID, {
      type: 'object',
      properties: {
        apiVersion: {
          type: 'string',
        },
        metadata: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
            },
          },
        },
        kind: {
          type: 'string',
          enum: ['Pod', 'PodTemplate'],
        },
      },
    });
    const content = 'kind: Po';
    const completion = await parseSetup(content, 1, 9);
    expect(completion.items.length).equal(2);
    expect(completion.items[0].insertText).equal('Pod');
    expect(completion.items[1].insertText).equal('PodTemplate');
  });

  it('Autocomplete indent on array when parent is array', async () => {
    languageService.addSchema(SCHEMA_ID, {
      type: 'object',
      properties: {
        examples: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              objectWithArray: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
    });
    const content = 'examples:\n  - ';
    const completion = await parseSetup(content, 1, 4);

    expect(completion.items.length).equal(1);
    expect(completion.items[0]).to.be.deep.equal(
      createExpectedCompletion('objectWithArray', 'objectWithArray:\n    - ${1:""}', 1, 4, 1, 4, 10, 2, {
        documentation: '',
      })
    );
  });
  it('Autocomplete indent on array object when parent is array', async () => {
    languageService.addSchema(SCHEMA_ID, {
      type: 'object',
      properties: {
        examples: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              objectWithArray: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['item', 'item2'],
                  properties: {
                    item: { type: 'string' },
                    item2: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    });
    const content = 'examples:\n  - ';
    const completion = await parseSetup(content, 1, 4);

    expect(completion.items.length).equal(1);
    expect(completion.items[0]).to.be.deep.equal(
      createExpectedCompletion('objectWithArray', 'objectWithArray:\n    - item: $1\n      item2: $2', 1, 4, 1, 4, 10, 2, {
        documentation: '',
      })
    );
  });
  describe('array indent on different index position', () => {
    const schema = {
      type: 'object',
      properties: {
        objectWithArray: {
          type: 'array',
          items: {
            type: 'object',
            required: ['item', 'item2'],
            properties: {
              item: { type: 'string' },
              item2: {
                type: 'object',
                required: ['prop1', 'prop2'],
                properties: {
                  prop1: { type: 'string' },
                  prop2: { type: 'string' },
                },
              },
            },
          },
        },
      },
    };
    it('array indent on the first item', async () => {
      languageService.addSchema(SCHEMA_ID, schema);
      const content = 'objectWithArray:\n  - ';
      const completion = await parseSetup(content, 1, 4);

      expect(completion.items.length).equal(3);
      expect(completion.items[0]).to.be.deep.equal(
        createExpectedCompletion('item', 'item: ', 1, 4, 1, 4, 10, 2, {
          documentation: '',
        })
      );
      expect(completion.items[2]).to.be.deep.equal(
        createExpectedCompletion('item2', 'item2:\n    prop1: $1\n    prop2: $2', 1, 4, 1, 4, 10, 2, {
          documentation: '',
        })
      );
    });
    it('array indent on the second item', async () => {
      languageService.addSchema(SCHEMA_ID, schema);
      const content = 'objectWithArray:\n  - item: first line\n    ';
      const completion = await parseSetup(content, 2, 4);

      expect(completion.items.length).equal(2);
      expect(completion.items[0]).to.be.deep.equal(
        createExpectedCompletion('item2', 'item2:\n  prop1: $1\n  prop2: $2', 2, 4, 2, 4, 10, 2, {
          documentation: '',
        })
      );
    });
  });

  describe('merge properties from anyOf objects', () => {
    it('should merge different simple values', async () => {
      const schema: JSONSchema = {
        anyOf: [
          {
            properties: {
              simplePropWithSimpleValue: { type: 'string', const: 'const value' },
            },
          },
          {
            properties: {
              simplePropWithSimpleValue: { type: 'boolean', default: false },
            },
          },
          {
            properties: {
              simplePropWithSimpleValue: { type: 'null', default: null },
            },
          },
          {
            properties: {
              simplePropWithSimpleValue: { type: 'string' },
            },
          },
        ],
      };
      languageService.addSchema(SCHEMA_ID, schema);
      const content = '';
      const completion = await parseSetup(content, 0, 1);

      expect(completion.items.length).equal(1);
      expect(completion.items[0].insertText).to.be.equal('simplePropWithSimpleValue: ${1|const value,false,null|}');
    });

    it('should autocomplete as single item with same value', async () => {
      const schema: JSONSchema = {
        anyOf: [
          {
            properties: {
              simplePropWithSameValue: { type: 'string', const: 'const value 1' },
              obj1: { properties: { prop1: { type: 'string' } } },
            },
          },
          {
            properties: {
              simplePropWithSameValue: { type: 'string', const: 'const value 1' },
              obj1: { properties: { prop1: { type: 'string' } } },
            },
          },
        ],
      };
      languageService.addSchema(SCHEMA_ID, schema);
      const content = '';
      const completion = await parseSetup(content, 0, 1);

      expect(completion.items.length).equal(2);
      expect(completion.items[0].insertText).to.be.equal('simplePropWithSameValue: const value 1');
      expect(completion.items[1].insertText).to.be.equal('obj1:\n  ');
    });

    it('should not merge objects', async () => {
      const schema: JSONSchema = {
        anyOf: [
          {
            properties: {
              obj1: { properties: { prop1: { type: 'string' } }, required: ['prop1'] },
            },
          },
          {
            properties: {
              obj1: { properties: { prop2: { type: 'string', const: 'value' } }, required: ['prop2'] },
            },
          },
        ],
      };
      languageService.addSchema(SCHEMA_ID, schema);
      const content = '';
      const completion = await parseSetup(content, 0, 1);

      expect(completion.items.length).equal(2);
      expect(completion.items[0].label).to.be.equal('obj1');
      expect(completion.items[0].insertText).to.be.equal('obj1:\n  prop1: ');
      expect(completion.items[1].label).to.be.equal('obj1');
      expect(completion.items[1].insertText).to.be.equal('obj1:\n  prop2: ${1:value}');
    });
  });
  describe('extra space after cursor', () => {
    it('simple const', async () => {
      const schema: JSONSchema = {
        properties: {
          prop: {
            const: 'const',
          },
        },
      };
      languageService.addSchema(SCHEMA_ID, schema);
      const content = 'prop:   ';
      const completion = await parseSetup(content, 0, 6);

      expect(completion.items.length).equal(1);
      expect(completion.items[0].label).to.be.equal('const');
      expect(completion.items[0].textEdit).to.be.deep.equal({ newText: 'const', range: Range.create(0, 6, 0, content.length) });
    });

    it('partial key with trailing spaces', async () => {
      const schema: JSONSchema = {
        properties: {
          name: {
            const: 'my name',
          },
        },
      };
      languageService.addSchema(SCHEMA_ID, schema);
      const content = 'na  ';
      const completion = await parseSetup(content, 0, 2);

      expect(completion.items.length).equal(1);
      expect(completion.items[0]).eql(
        createExpectedCompletion('name', 'name: my name', 0, 0, 0, 4, 10, 2, {
          documentation: '',
        })
      );
    });

    it('partial key with leading and trailing spaces', async () => {
      const schema: JSONSchema = {
        properties: {
          name: {
            const: 'my name',
          },
        },
      };
      languageService.addSchema(SCHEMA_ID, schema);
      const content = '  na  ';
      const completion = await parseSetup(content, 0, 2);

      expect(completion.items.length).equal(1);
      expect(completion.items[0]).eql(
        createExpectedCompletion('name', 'name: my name', 0, 2, 0, 4, 10, 2, {
          documentation: '',
        })
      );
    });

    it('object - 2nd nested property', async () => {
      const schema: JSONSchema = {
        properties: {
          parent: {
            properties: {
              prop1: {
                const: 'const1',
              },
              prop2: {
                const: 'const2',
              },
            },
          },
        },
      };
      languageService.addSchema(SCHEMA_ID, schema);
      const content = 'parent:\n  prop1: const1\n  prop2:   ';
      const completion = await parseSetup(content, 2, 9);

      expect(completion.items.length).equal(1);
      expect(completion.items[0].label).to.be.equal('const2');
      expect(completion.items[0].textEdit).to.be.deep.equal({
        newText: 'const2',
        range: Range.create(2, 9, 2, 11),
      });
    });

    it('array - 2nd nested property', async () => {
      const schema: JSONSchema = {
        properties: {
          arrayObj: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item1: {
                  type: 'string',
                },
                item2: {
                  const: 'const2',
                },
              },
              required: ['item1', 'item2'],
            },
          },
        },
      };
      languageService.addSchema(SCHEMA_ID, schema);
      const content = 'arrayObj:\n  - item1: test\n  - item2:   ';
      const completion = await parseSetup(content, 2, 11);

      expect(completion.items.length).equal(1);
      expect(completion.items[0].label).to.be.equal('const2');
      expect(completion.items[0].textEdit).to.be.deep.equal({
        newText: 'const2',
        range: Range.create(2, 11, 2, 13),
      });
    });
    describe('array object item', () => {
      const schema: JSONSchema = {
        properties: {
          arrayObj: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item1: {
                  type: 'string',
                },
                item2: {
                  type: 'string',
                },
              },
              required: ['item1', 'item2'],
            },
          },
        },
      };
      it('1st item', async () => {
        languageService.addSchema(SCHEMA_ID, schema);
        const content = 'arrayObj:\n  -   ';
        const completion = await parseSetup(content, 1, 4);

        expect(completion.items.length).equal(3);
        expect(completion.items[1].textEdit).to.be.deep.equal({
          newText: 'item1: $1\n  item2: $2',
          range: Range.create(1, 4, 1, 6), // removes extra spaces after cursor
        });
      });
      it('next item', async () => {
        languageService.addSchema(SCHEMA_ID, schema);
        const content = 'arrayObj:\n  - item1: a\n  - item2: b\n  -   ';
        const completion = await parseSetup(content, 3, 4);

        expect(completion.items.length).equal(3);
        expect(completion.items[1].textEdit).to.be.deep.equal({
          newText: 'item1: $1\n  item2: $2',
          range: Range.create(3, 4, 3, 6), // removes extra spaces after cursor
        });
      });
    });
  }); //'extra space after cursor'

  it('should suggest from additionalProperties', async () => {
    const schema: JSONSchema = {
      type: 'object',
      additionalProperties: {
        anyOf: [
          {
            type: 'string',
            const: 'test1',
          },
        ],
      },
    };
    languageService.addSchema(SCHEMA_ID, schema);
    const content = 'value: ';
    const completion = await parseSetup(content, 0, content.length);

    expect(completion.items.length).equal(1);
    expect(completion.items[0].insertText).to.be.equal('test1');
  });
  it('should suggest property of unknown object', async () => {
    const schema: JSONSchema = {
      type: 'object',
      additionalProperties: true,
      propertyNames: {
        title: 'property',
        description: 'Property Description',
      },
    };
    languageService.addSchema(SCHEMA_ID, schema);
    const content = '';
    const completion = await parseSetup(content, 0, content.length);

    expect(completion.items.length).equal(1);
    expect(completion.items[0].insertText).to.be.equal('${1:property}: ');
    expect(completion.items[0].documentation).to.be.equal('Property Description');
  });

  describe('should suggest property before indented comment', () => {
    const schema: JSONSchema = {
      type: 'object',
      properties: {
        example: {
          type: 'object',
          properties: {
            prop1: {
              type: 'string',
            },
            prop2: {
              type: 'string',
            },
          },
        },
      },
    };

    it('completion should handle indented comment on new line', async () => {
      languageService.addSchema(SCHEMA_ID, schema);
      const content = 'example:\n  prop1: "test"\n  \n    #comment';
      const completion = await parseSetup(content, 2, 2);
      expect(completion.items.length).equal(1);
      expect(completion.items[0]).to.be.deep.equal(
        createExpectedCompletion('prop2', 'prop2: ', 2, 2, 2, 2, CompletionItemKind.Property, InsertTextFormat.Snippet, {
          documentation: '',
        })
      );
    });

    it('completion should handle comment at same indent level on new line', async () => {
      languageService.addSchema(SCHEMA_ID, schema);
      const content = 'example:\n  prop1: "test"\n  \n  #comment';
      const completion = await parseSetup(content, 2, 2);
      expect(completion.items.length).equal(1);
      expect(completion.items[0]).to.be.deep.equal(
        createExpectedCompletion('prop2', 'prop2: ', 2, 2, 2, 2, CompletionItemKind.Property, InsertTextFormat.Snippet, {
          documentation: '',
        })
      );
    });
  });

  describe('should suggest prop of the object (based on not completed prop name)', () => {
    const schema: JSONSchema = {
      definitions: {
        Obj: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                prop1: { type: 'string' },
              },
              required: ['prop1'],
            },
          ],
        },
      },
      properties: {
        test1: {
          properties: {
            nested: { $ref: '#/definitions/Obj' },
          },
        },
        test2: { $ref: '#/definitions/Obj' },
      },
    };
    const content = `
test2: 
  pr
test1:
  nested: 
    pr
`;
    it('nested object', async () => {
      languageService.addSchema(SCHEMA_ID, schema);
      const completion = await parseSetup(content, 5, 6);

      expect(completion.items.length).equal(2);
      expect(completion.items[0].label).to.be.equal('prop1');
    });
    it('root object', async () => {
      languageService.addSchema(SCHEMA_ID, schema);
      const completion = await parseSetup(content, 2, 4);

      expect(completion.items.length).equal(2);
      expect(completion.items[0].label).to.be.equal('prop1');
    });
  });
});
