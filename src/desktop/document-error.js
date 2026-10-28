/**
 * The coded error every document import raises, whatever the file type
 * (document-import.js, csv-document.js). `code` is the IPC failure code
 * (E_DOC_*); `message` is what the rep reads.
 */
export class DocumentImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DocumentImportError";
    this.code = code;
  }
}
