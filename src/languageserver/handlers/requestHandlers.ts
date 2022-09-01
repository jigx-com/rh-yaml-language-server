/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Connection, TextDocumentPositionParams } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  MODIFICATION_ACTIONS,
  SchemaAdditions,
  SchemaDeletions,
  SchemaDeletionsAll,
} from '../../languageservice/services/yamlSchemaService';
import { LanguageService } from '../../languageservice/yamlLanguageService';
import {
  HoverDetailRequest,
  RevalidateBySchemaRequest,
  RevalidateRequest,
  SchemaModificationNotification,
} from '../../requestTypes';
import { SettingsState } from '../../yamlSettings';
import { ValidationHandler } from './validationHandlers';

export class RequestHandlers {
  private languageService: LanguageService;
  constructor(
    private readonly connection: Connection,
    languageService: LanguageService,
    private yamlSettings: SettingsState,
    private validationHandler: ValidationHandler
  ) {
    this.languageService = languageService;
  }

  public registerHandlers(): void {
    this.connection.onRequest(SchemaModificationNotification.type, (modifications) =>
      this.registerSchemaModificationNotificationHandler(modifications)
    );

    /**
     * Received request from the client that detail info is needed.
     */
    this.connection.onRequest(HoverDetailRequest.type, (params: TextDocumentPositionParams) => {
      const document = this.yamlSettings.documents.get(params.textDocument.uri);
      // return this.languageService.doHover(document, params.position);
      return this.languageService.doHoverDetail(document, params.position);
    });

    /**
     * Received request from the client that revalidation is needed.
     */
    this.connection.onRequest(RevalidateRequest.type, async (uri: string) => {
      const document = this.yamlSettings.documents.get(uri);
      await this.validationHandler.validateTextDocument(document);
    });

    /**
     * Received request from the client that revalidation is needed.
     */
    this.connection.onRequest(RevalidateBySchemaRequest.type, async (params: { yaml: string; schema: unknown }) => {
      const yamlName = Math.random().toString(36).substring(2) + '.yaml';
      const document = TextDocument.create(yamlName, 'yaml', 0, params.yaml);
      this.languageService.addSchema(yamlName, params.schema);
      try {
        const result = await this.languageService.doValidation(document, false);
        return result;
      } finally {
        this.languageService.deleteSchema(yamlName);
      }
    });
  }

  private registerSchemaModificationNotificationHandler(
    modifications: SchemaAdditions | SchemaDeletions | SchemaDeletionsAll
  ): void {
    if (modifications.action === MODIFICATION_ACTIONS.add) {
      this.languageService.modifySchemaContent(modifications);
    } else if (modifications.action === MODIFICATION_ACTIONS.delete) {
      this.languageService.deleteSchemaContent(modifications);
    } else if (modifications.action === MODIFICATION_ACTIONS.deleteAll) {
      this.languageService.deleteSchemasWhole(modifications);
    }
  }
}
