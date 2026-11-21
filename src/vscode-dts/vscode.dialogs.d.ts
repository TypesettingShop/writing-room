declare module 'vscode' {
  /**
   * What the open dialog offers. The dialog is the workbench's own quick input and reaches only the
   * workspace folders.
   */
  export interface OpenDialogOptions {
    /** Where the dialog starts. Outside the workspace folders it starts at the first one. */
    defaultUri?: Uri;
    /** The name of the choice that picks the folder the dialog shows. */
    openLabel?: string;
    /** Files can be picked. When neither files nor folders are asked for, files are. */
    canSelectFiles?: boolean;
    /** Folders can be picked. */
    canSelectFolders?: boolean;
    /** Taken, but one item is picked at a time; the result is a list either way. */
    canSelectMany?: boolean;
    /** Lists only files with these extensions, by filter name, such as `{ 'Markdown': ['md'] }`. */
    filters?: { [name: string]: string[] };
    /** The dialog's title. */
    title?: string;
  }

  /** What the save dialog offers. It asks before it replaces a file. */
  export interface SaveDialogOptions {
    /** Where the dialog starts: a folder, or a file whose name it suggests. */
    defaultUri?: Uri;
    /** The name of the choice that saves under the suggested name. */
    saveLabel?: string;
    /** Lists only files with these extensions, by filter name. */
    filters?: { [name: string]: string[] };
    /** The dialog's title. */
    title?: string;
  }

  export namespace window {
    /**
     * Lets the user pick files or folders in the workspace. Resolves to what was picked, always a
     * list, or `undefined` when the dialog was cancelled.
     */
    export function showOpenDialog(options?: OpenDialogOptions): Thenable<Uri[] | undefined>;

    /** Lets the user pick where to save in the workspace. Resolves to that place, or `undefined` when cancelled. */
    export function showSaveDialog(options?: SaveDialogOptions): Thenable<Uri | undefined>;
  }
}
