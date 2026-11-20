/** Proposals whose registration APIs the extension host accepts. Shared with the workbench's manifest notices. */
export const acceptedApiProposals = {
  externalUriOpener: 'window.registerExternalUriOpener',
  multiDocumentHighlightProvider: 'languages.registerMultiDocumentHighlightProvider',
  documentPaste: 'languages.registerDocumentPasteEditProvider',
} as const;
