import { baseKeymap, selectAll } from 'prosemirror-commands';
import { undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { TextSelection } from 'prosemirror-state';
import type { Command, EditorState } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import { EditorView } from 'prosemirror-view';
import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import type { Dimension } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { getKeybindingPlatform } from '../../../../base/common/keybindings.js';
import { combinedDisposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { clearMonacoUndoHistory } from '../../../../editor/browser/monaco.js';
import type { ITextEditorModel } from '../../../../editor/common/services/resolverService.js';
import type { ITextEditorOptions, ITextEditorSelection } from '../../../../platform/editor/common/editor.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { GroupModelChangeKind } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { TextFileEditorModel } from '../../../services/textfile/common/textFileEditorModel.js';
import { describeFileOpenError } from '../../files/browser/editors/textFileEditor.js';
import { SAVE_FILE_COMMAND_ID } from '../../files/browser/fileCommands.js';
import {
  defaultMarkdownContentLayout, defaultMarkdownFocusWidth, defaultMarkdownFontFamilies, defaultMarkdownFonts,
  defaultMarkdownHeadingSizes, defaultMarkdownSubtitleSize, isMarkdownContentWidth, MARKDOWN_EDITOR_CONTENT_LAYOUT,
  MARKDOWN_EDITOR_CONTENT_WIDTH, MARKDOWN_EDITOR_FOCUS_DIM, MARKDOWN_EDITOR_FOCUS_WIDTH, MARKDOWN_EDITOR_FONT_FAMILY,
  MARKDOWN_EDITOR_FONT_SIZE, MARKDOWN_EDITOR_TYPEWRITER, markdownContentWidth, MarkdownEditorCanRedoContext,
  MarkdownEditorCanUndoContext, MarkdownEditorContentLayoutContext, MarkdownEditorContentWidthContext,
  MarkdownEditorFocusContext, MarkdownEditorModeContext, MarkdownEditorWritableContext, resolveMarkdownFontDefaults,
  scaleMarkdownTitleSize,
} from '../common/markdownEditor.js';
import type { MarkdownEditorMode } from '../common/markdownEditor.js';
import { bindMarkdownFormattingContext } from './markdownEditorFormattingContext.js';
import { bindMarkdownGutter, onMarkdownScrollbar } from './markdownEditorGutter.js';
import { toMarkdownSelection, toSourceSelection } from './markdownEditorSelection.js';
import { indentMarkdownCode } from './markdownEditorBlockStyles.js';
import { markdownClipboard, pasteFromMarkdownClipboard } from './markdownEditorClipboard.js';
import {
  getReadOnlyMarkdownSelection, isOverMarkdownSelection, moveMarkdownContextCaret, showMarkdownContextMenu,
} from './markdownEditorContextMenu.js';
import type { MarkdownClipboardOperation } from './markdownEditorContextMenu.js';
import { markdownInputRules } from './markdownEditorInputRules.js';
import { setFormattingPreset } from './markdownEditorPresets.js';
import type { PresetAxisId } from './markdownEditorPresets.js';
import { markdownImageView } from './markdownEditorImages.js';
import { markdownListKeys, taskItemView } from './markdownEditorLists.js';
import { markdownTablePlugins, moveMarkdownTableCell } from './markdownEditorTables.js';
import { centerMarkdownCaret, markdownActiveBlock } from './markdownFocusPresentation.js';
import { MarkdownEditorInput } from './markdownEditorInput.js';
import { MarkdownEditorModel } from './markdownEditorModel.js';
import 'prosemirror-view/style/prosemirror.css';
import './markdownEditor.css';
import './media/markdownTheme.css';

const compositionCommands = [SAVE_FILE_COMMAND_ID, 'markdownEditor.toggleSource'] as const;

export class MarkdownEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.markdownEditor';

  private surface!: HTMLElement;
  private frame!: HTMLElement;
  private error!: HTMLElement;
  private view: EditorView | undefined;
  private sync: MarkdownEditorModel | undefined;
  private readonly session = this._register(new DisposableStore());
  private readonly contextMenu = this._register(new MutableDisposable<IDisposable>());
  private readonly tabModels = new Map<MarkdownEditorInput, { model: MarkdownEditorModel; lifetime: IDisposable }>();
  private readonly historyChanged = this._register(new Emitter<void>());
  readonly onDidChangeHistory = this.historyChanged.event;
  private request = 0;
  private pendingFocus = false;
  private typewriter = false;
  private pointerSelection = false;
  private committingComposition = false;
  private scrollFrame: number | undefined;
  private scoped: IContextKeyService | undefined;
  private fontDefaults = defaultMarkdownFonts;
  private updateToolbarContext = () => {};

  constructor(
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @IKeybindingService private readonly keybindings: IKeybindingService,
    @IContextKeyService private readonly contextKeys: IContextKeyService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IConfigurationService private readonly configuration: IConfigurationService,
    @IFileService private readonly files: IFileService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
  ) {
    super(MarkdownEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.frame = append(parent, $('.markdown-editor-frame', { hidden: '' }));
    const toolbar = append(this.frame, $('.markdown-editor-toolbar'));
    this.surface = append(this.frame, $('.markdown-editor-surface'));
    const scoped = this.scoped = this._register(this.contextKeys.getScopedContextKeyService(parent).createScoped(parent));
    const surfaceScope = this._register(scoped.createScoped(this.surface));
    MarkdownEditorFocusContext.bindTo(surfaceScope).set(true);
    // Leave the key unset without a view so the group's mode (title menu, source toggle) still shows through.
    const mode = scoped.createKey<MarkdownEditorMode>(MarkdownEditorModeContext.key, undefined);
    const writable = MarkdownEditorWritableContext.bindTo(scoped);
    const updateFormatting = bindMarkdownFormattingContext(scoped);
    const undo = MarkdownEditorCanUndoContext.bindTo(scoped);
    const redo = MarkdownEditorCanRedoContext.bindTo(scoped);
    this.updateToolbarContext = () => {
      if (this.view) {
        mode.set('wysiwyg');
      } else {
        mode.reset();
      }
      writable.set(this.formattingState !== undefined);
      updateFormatting(this.view && this.sync?.state, this.fontDefaults);
      undo.set(this.canUndo);
      redo.set(this.canRedo);
    };
    this._register(this.instantiation.createInstance(
      MenuWorkbenchToolBar, { element: toolbar, ariaLabel: 'Markdown formatting' }, MenuId.MarkdownEditorToolbar, scoped,
    ));
    const updateFonts = () => {
      const familySetting = this.configuration.getValue(MARKDOWN_EDITOR_FONT_FAMILY);
      this.fontDefaults = resolveMarkdownFontDefaults(this.configuration.getValue(MARKDOWN_EDITOR_FONT_SIZE), familySetting);
      const { size, family } = this.fontDefaults;
      this.frame.style.setProperty('--markdown-body-font-size', `${size}pt`);
      for (const [index, headingSize] of defaultMarkdownHeadingSizes.entries()) {
        this.frame.style.setProperty(`--markdown-h${index + 1}-font-size`, `${scaleMarkdownTitleSize(headingSize, size)}pt`);
      }
      this.frame.style.setProperty('--markdown-subtitle-font-size', `${scaleMarkdownTitleSize(defaultMarkdownSubtitleSize, size)}pt`);
      this.frame.style.setProperty('--markdown-editor-font-family', `var(--markdown-font-${family})`);
      const families = typeof familySetting === 'object' && familySetting !== null
        ? familySetting as Partial<Record<'serif' | 'sans', unknown>> : undefined;
      const css = parent.ownerDocument.defaultView?.CSS;
      for (const name of ['serif', 'sans'] as const) {
        const value = families?.[name];
        const supported = typeof value === 'string' && css?.supports('font-family', value);
        this.frame.style.setProperty(`--markdown-editor-font-${name}`, supported ? value : defaultMarkdownFontFamilies[name]);
      }
      this.updateToolbarContext();
    };
    updateFonts();
    this._register(this.configuration.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(MARKDOWN_EDITOR_FONT_FAMILY) || event.affectsConfiguration(MARKDOWN_EDITOR_FONT_SIZE)) {
        updateFonts();
      }
    }));
    const contentWidth = MarkdownEditorContentWidthContext.bindTo(scoped);
    const contentLayout = MarkdownEditorContentLayoutContext.bindTo(scoped);
    const updateContentLayout = () => {
      const value = this.configuration.getValue(MARKDOWN_EDITOR_CONTENT_WIDTH);
      const width = isMarkdownContentWidth(value) ? value : markdownContentWidth.defaultValue;
      const layout = this.configuration.getValue(MARKDOWN_EDITOR_CONTENT_LAYOUT) === 'fill' ? 'fill' : defaultMarkdownContentLayout;
      this.frame.style.setProperty('--markdown-content-width', `${width}ch`);
      this.frame.classList.toggle('markdown-content-fill', layout === 'fill');
      contentWidth.set(width);
      contentLayout.set(layout);
    };
    updateContentLayout();
    this._register(bindMarkdownGutter(this.surface, () => this.view));
    this._register(this.configuration.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(MARKDOWN_EDITOR_CONTENT_WIDTH) || event.affectsConfiguration(MARKDOWN_EDITOR_CONTENT_LAYOUT)) {
        updateContentLayout();
      }
    }));
    const updateWritingPreferences = () => {
      const width = this.configuration.getValue(MARKDOWN_EDITOR_FOCUS_WIDTH);
      const supported = typeof width === 'string' && parent.ownerDocument.defaultView?.CSS.supports('max-width', width);
      this.frame.style.setProperty('--markdown-focus-width', supported ? width : defaultMarkdownFocusWidth);
      this.frame.classList.toggle('markdown-dim-others', this.configuration.getValue(MARKDOWN_EDITOR_FOCUS_DIM) === true);
      this.typewriter = this.configuration.getValue(MARKDOWN_EDITOR_TYPEWRITER) === true;
      this.surface.classList.toggle('markdown-typewriter', this.typewriter);
      this.scheduleTypewriter();
    };
    updateWritingPreferences();
    this._register(this.configuration.onDidChangeConfiguration(event => {
      if ([MARKDOWN_EDITOR_FOCUS_WIDTH, MARKDOWN_EDITOR_FOCUS_DIM, MARKDOWN_EDITOR_TYPEWRITER]
        .some(key => event.affectsConfiguration(key))) {
        updateWritingPreferences();
      }
    }));
    const ResizeObserver = parent.ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserver) {
      const observer = new ResizeObserver(() => this.scheduleTypewriter());
      observer.observe(this.surface);
      this._register(toDisposable(() => observer.disconnect()));
    }
    const group = this.groups.groups.find(group => group.element.contains(parent));
    if (group) {
      toolbar.addEventListener('click', () => {
        this.groups.activateGroup(group);
        if (!parent.contains(parent.ownerDocument.activeElement)) {
          this.focus();
        }
      }, true);
      this._register(group.onDidModelChange(({ kind, editor }) => {
        if (kind === GroupModelChangeKind.EDITOR_CLOSE && editor instanceof MarkdownEditorInput) {
          this.forgetTabModel(editor);
        }
      }));
      this._register(this.groups.onDidChangeActiveGroup(active => {
        if (active !== group) this.contextMenu.clear();
      }));
    }
    this.error = append(parent, $('.markdown-editor-error', { hidden: '', role: 'alert', tabindex: '-1' }));
  }

  override get scopedContextKeyService(): IContextKeyService | undefined {
    return this.scoped;
  }

  override async setInput(input: EditorInput, options: ITextEditorOptions | undefined): Promise<void> {
    if (this.view && input === this.input) {
      void super.setInput(input, options);
      this.applySelection(options?.selection);
      return;
    }
    const focus = this.view?.hasFocus() ?? this.pendingFocus;
    this.clearInput();
    this.pendingFocus = focus && !options?.preserveFocus;
    void super.setInput(input, options);
    const request = this.request;
    if (!(input instanceof MarkdownEditorInput)) {
      return;
    }
    // Keep opening the editor while the browser fetches the font definitions.
    void import('./markdownEditorFonts.js').catch(error => console.warn('Could not load Markdown webfonts.', error));
    this.session.add(input.onWillDispose(() => this.clearInput()));

    try {
      const resolved = await input.resolve();
      if (request !== this.request) {
        return;
      }
      const sync = this.sync = this.getTabModel(input, resolved);
      const view = this.view = new EditorView(this.surface, {
        state: sync.state,
        editable: () => !input.isReadonly(),
        attributes: () => ({
          role: 'textbox', 'aria-label': 'Markdown editor', 'aria-multiline': 'true',
          'aria-readonly': String(input.isReadonly()), tabindex: '0',
        }),
        ...markdownClipboard,
        handleScrollToSelection: view => {
          if (this.pointerSelection) return false;
          this.scheduleTypewriter();
          // Typewriter centering waits for the composition to end, so keep the caret in view meanwhile.
          return this.typewriter && !view.composing;
        },
        nodeViews: {
          image: (node, view) => markdownImageView(node, view.dom.ownerDocument, input.resource, this.files, this.workspace),
          task_item: (node, view, getPos) => taskItemView(node, view.dom.ownerDocument, checked => {
            if (getPos() === undefined || input.isReadonly()) return false;
            // A queued command runs after a pending source change, so find the item in that state.
            return this.runFormattingCommand((state, dispatch) => {
              const pos = getPos();
              const current = pos === undefined ? null : state.doc.nodeAt(pos);
              if (pos === undefined || current?.type !== node.type) return false;
              dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked }));
              return true;
            });
          }, () => !input.isReadonly()),
        },
        dispatchTransaction: transaction => {
          if (!transaction.docChanged || !input.isReadonly()) {
            // A click or drag only moves the selection; centering it would move the text under the pointer.
            // prosemirror-tables selects cells under the mouse without the pointer flag or a scroll request.
            this.pointerSelection = !transaction.docChanged && (transaction.getMeta('pointer') === true
              || (transaction.selection instanceof CellSelection && !transaction.scrolledIntoView));
            try {
              sync.dispatch(transaction);
            } finally {
              this.pointerSelection = false;
            }
          }
        },
        handleDOMEvents: {
          keydown: (_view, event) => {
            if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && this.openContextMenu()) {
              event.preventDefault();
              return true;
            }
            return this.keybindings.dispatchDuringComposition?.(event, compositionCommands) ?? false;
          },
          compositionend: () => {
            queueMicrotask(() => {
              if (this.view === view) this.scheduleTypewriter();
            });
            return false;
          },
          click: (_view, event) => {
            if (event.target instanceof Element && event.target.closest('a')) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      });
      this.session.add(toDisposable(() => view.destroy()));
      // Finish native input before ProseMirror or the surface moves the selection under the pointer.
      // A touch keeps ProseMirror's own touchstart handling: blurring there would close the on-screen keyboard.
      this.session.add(addDisposableListener(this.surface, 'pointerdown', event => {
        if (event.pointerType !== 'touch') this.commitComposition();
      }, true));
      const isOverScrollbar = (event: MouseEvent) => event.target === this.surface && onMarkdownScrollbar(this.surface, event);
      // macOS also opens the context menu on Control+click, which reports the primary button.
      const mac = getKeybindingPlatform(view.dom.ownerDocument.defaultView!.navigator.platform) === 'mac';
      this.session.add(addDisposableListener(this.surface, 'mousedown', event => {
        // The app positions the caret on contextmenu. Keep the browser and ProseMirror from changing the selection first.
        const secondary = event.button === 2 || (mac && event.button === 0 && event.ctrlKey);
        if (secondary && !event.shiftKey && !isOverScrollbar(event)) event.preventDefault();
      }, true));
      this.session.add(addDisposableListener(this.surface, 'contextmenu', event => {
        if (event.shiftKey || isOverScrollbar(event)) return;
        const keyboard = event.button === 0 && event.clientX === 0 && event.clientY === 0;
        if (this.openContextMenu(keyboard ? undefined : event)) event.preventDefault();
      }, true));
      this.session.add(addDisposableListener(this.surface, 'scroll', () => this.contextMenu.clear()));
      this.session.add(input.onWillSave(() => this.commitComposition()));
      this.session.add(addDisposableListener(view.dom.ownerDocument.defaultView!, 'blur', () => this.commitComposition()));
      this.session.add(input.onDidChangeLabel(() => {
        this.commitComposition();
        this.contextMenu.clear();
        view.setProps({});
        // Unchanged task items keep their node views, so their checkboxes follow the read-only state here.
        for (const checkbox of view.dom.querySelectorAll<HTMLInputElement>('li[data-task-checked] > input[type="checkbox"]')) {
          checkbox.disabled = input.isReadonly();
        }
        this.updateHistoryContext();
      }));
      this.frame.hidden = false;
      this.scheduleTypewriter();
      this.updateHistoryContext();
      this.applySelection(options?.selection);
    } catch (error) {
      if (request !== this.request) {
        return;
      }
      this.frame.hidden = true;
      this.error.hidden = false;
      this.error.textContent = `${input.getName()}: ${describeFileOpenError(error)}`;
    }
    if (this.pendingFocus) {
      this.focus();
    }
  }

  override clearInput(): void {
    this.contextMenu.clear();
    this.commitComposition(false);
    this.request++;
    this.pendingFocus = false;
    const window = this.surface.ownerDocument.defaultView;
    if (this.scrollFrame !== undefined) {
      window?.cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = undefined;
    }
    this.session.clear();
    this.view = undefined;
    this.sync = undefined;
    this.frame.hidden = true;
    this.error.hidden = true;
    this.error.textContent = '';
    super.clearInput();
    this.updateHistoryContext();
  }

  private commitComposition(restoreFocus = true): void {
    const view = this.view;
    if (!view?.composing || this.committingComposition) return;
    this.committingComposition = true;
    try {
      const focused = view.hasFocus();
      if (focused) view.dom.blur();
      if (view.isDestroyed) return;
      // Blur lets the browser finish the native composition. Drain ProseMirror's observer now
      // so the following command, source change, or view destruction sees the final mutation.
      const { domObserver } = view as EditorView & { domObserver: { forceFlush(always: boolean): void } };
      domObserver.forceFlush(true);
      const activeElement = view.root.activeElement;
      if (focused && restoreFocus && (!activeElement || activeElement === view.dom.ownerDocument.body)) {
        view.focus();
      }
    } finally {
      this.committingComposition = false;
    }
  }

  private openContextMenu(event?: MouseEvent): boolean {
    this.commitComposition();
    const view = this.view;
    const scope = this.scoped;
    if (!view || !scope) return false;
    const group = this.groups.groups.find(group => group.activeEditorPane === this);
    if (!group) return false;
    this.contextMenu.clear();
    this.groups.activateGroup(group);
    this.focus();

    let point: { x: number; y: number };
    if (event) {
      const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
      const inside = isOverMarkdownSelection(view, event);
      if (!inside) moveMarkdownContextCaret(this.surface, view, event, hit);
      // Leave the clicked line visible when preserving a selection.
      const y = inside && hit ? Math.max(event.clientY, view.coordsAtPos(hit.pos).bottom) : event.clientY;
      point = { x: event.clientX, y };
    } else {
      const readOnly = view.editable ? undefined : getReadOnlyMarkdownSelection(view);
      const head = readOnly?.focusNode ? view.posAtDOM(readOnly.focusNode, readOnly.focusOffset) : view.state.selection.head;
      const caret = view.coordsAtPos(head);
      point = { x: caret.left, y: caret.bottom };
    }
    // The head can be scrolled out of the surface (after Select All, for example); open at the nearest visible edge.
    const surface = this.surface.getBoundingClientRect();
    const anchor = {
      x: Math.min(Math.max(point.x, surface.left), surface.right),
      y: Math.min(Math.max(point.y, surface.top), surface.bottom),
    };
    const isCurrent = () => this.view === view && this.groups.activeGroup.activeEditorPane === this;
    this.contextMenu.value = this.instantiation.invokeFunction(
      showMarkdownContextMenu, view, scope, anchor, this, isCurrent,
    );
    return this.contextMenu.value !== undefined;
  }

  async runClipboardCommand(operation: MarkdownClipboardOperation, warn: (message: string) => void): Promise<void> {
    this.commitComposition();
    const view = this.view;
    if (!view?.hasFocus() || (operation !== 'copy' && !view.editable)) return;
    const { doc, selection } = view.state;
    const isCurrent = () => this.view === view && this.groups.activeGroup.activeEditorPane === this;
    const isPaste = operation === 'paste' || operation === 'pastePlainText';
    try {
      if (isPaste) {
        // Clipboard permission can outlast focus, the tab, or the original destination.
        await pasteFromMarkdownClipboard(view, () => isCurrent() && view.editable && view.hasFocus()
          && view.state.doc === doc && selection.eq(view.state.selection), operation === 'pastePlainText');
      } else {
        const selected = view.editable ? !selection.empty : getReadOnlyMarkdownSelection(view)?.isCollapsed === false;
        if (selected && !view.dom.ownerDocument.execCommand(operation)) throw new Error('Clipboard command is unavailable');
      }
    } catch {
      if (isCurrent()) warn(`Could not ${isPaste ? 'paste' : operation} using the clipboard. Try the keyboard shortcut.`);
    }
  }

  selectAll(): void {
    this.commitComposition();
    const view = this.view;
    if (!view?.hasFocus()) return;
    if (view.editable) selectAll(view.state, view.dispatch);
    else view.dom.ownerDocument.getSelection()?.selectAllChildren(view.dom);
  }

  private scheduleTypewriter(): void {
    if (!this.typewriter || !this.view || this.view.composing || this.scrollFrame !== undefined) return;
    this.scrollFrame = this.surface.ownerDocument.defaultView?.requestAnimationFrame(() => {
      this.scrollFrame = undefined;
      if (this.typewriter && this.view && !this.view.composing) centerMarkdownCaret(this.surface, this.view);
    });
  }

  private updateHistoryContext(): void {
    this.updateToolbarContext();
    this.historyChanged.fire();
  }

  private getTabModel(input: MarkdownEditorInput, resolved: ITextEditorModel): MarkdownEditorModel {
    const tab = this.tabModels.get(input);
    if (tab) {
      return tab.model;
    }
    const textModel = resolved.textEditorModel;
    if (!textModel || textModel.isDisposed()) {
      throw new Error('the file has no text model.');
    }
    const undo: Command = () => { this.undo(); return true; };
    const redo: Command = () => { this.redo(); return true; };
    const keys = keymap({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo, Backspace: undoInputRule });
    const codeKeys = keymap({ Tab: indentMarkdownCode(false), 'Shift-Tab': indentMarkdownCode(true) });
    const tableKeys = keymap({ Tab: moveMarkdownTableCell(1), 'Shift-Tab': moveMarkdownTableCell(-1) });
    const model = new MarkdownEditorModel(textModel, [
      markdownInputRules, markdownActiveBlock, keys, codeKeys, tableKeys, keymap(markdownListKeys),
      ...markdownTablePlugins, keymap(baseKeymap),
    ], state => {
      if (this.input === input) {
        const previous = this.view?.state;
        // The read-only context menu already uses the native DOM selection, before PM observes it.
        if (previous && (previous.doc !== state.doc
          || (this.view?.editable && !previous.selection.eq(state.selection)))) {
          this.contextMenu.clear();
        }
        this.view?.updateState(state);
        if (!this.pointerSelection && (previous?.doc !== state.doc || previous?.selection.head !== state.selection.head)) {
          this.scheduleTypewriter();
        }
        this.updateHistoryContext();
      }
    }, resolved instanceof TextFileEditorModel ? edit => resolved.applyRichEditorEdit(edit) : undefined, () => {
      // A background tab model can receive the same source change as the visible one.
      if (this.input === input && this.view?.state === model.state) this.commitComposition();
    });
    const lifetime = combinedDisposable(model, input.onWillDispose(() => this.forgetTabModel(input)));
    this.tabModels.set(input, { model, lifetime });
    return model;
  }

  private forgetTabModel(input: MarkdownEditorInput): void {
    this.tabModels.get(input)?.lifetime.dispose();
    this.tabModels.delete(input);
  }

  get canUndo(): boolean {
    return this.view !== undefined && !this.input?.isReadonly() && (this.sync?.canUndo ?? false);
  }

  get canRedo(): boolean {
    return this.view !== undefined && !this.input?.isReadonly() && (this.sync?.canRedo ?? false);
  }

  undo(): boolean {
    this.commitComposition();
    return this.canUndo && this.sync!.undo();
  }

  redo(): boolean {
    this.commitComposition();
    return this.canRedo && this.sync!.redo();
  }

  get writingState(): EditorState | undefined {
    return this.view && this.sync?.state;
  }

  readonly onDidChangeWritingState = this.historyChanged.event;

  revealWritingPosition(position: number): void {
    const before = this.sync?.state.doc;
    this.commitComposition();
    if (this.sync && this.view) {
      const { doc } = this.sync.state;
      // The caller read `position` before the composition was committed, so carry it over that change.
      if (before && before !== doc) {
        const start = before.content.findDiffStart(doc.content);
        const end = before.content.findDiffEnd(doc.content);
        if (start !== null && end !== null && position > start) {
          position = position >= end.a ? Math.max(start, position + end.b - end.a) : Math.max(start, end.b);
        }
      }
      position = Math.min(position, doc.content.size);
      this.sync.dispatch(this.sync.state.tr.setSelection(TextSelection.create(doc, position)).scrollIntoView());
      this.view.focus();
    }
  }

  get formattingState(): EditorState | undefined {
    return this.view && this.input && !this.input.isReadonly() ? this.sync?.state : undefined;
  }

  getFormattingStateForQuickInput(): EditorState | undefined {
    // Opening quick input moves focus and can finish composition, invalidating an earlier snapshot.
    this.commitComposition();
    return this.formattingState;
  }

  formattingPresetCommand(axis: PresetAxisId, value: string): Command {
    return setFormattingPreset(axis, value, this.fontDefaults);
  }

  runFormattingCommand(command: Command): boolean {
    this.commitComposition();
    return this.formattingState !== undefined && this.sync!.runFormattingCommand(command);
  }

  resetHistory(): void {
    this.sync?.resetHistory();
  }

  resetSourceHistory(): void {
    if (this.sync) {
      clearMonacoUndoHistory(this.sync.textModel);
    }
  }

  getSourceSelection(): ITextEditorSelection | undefined {
    this.commitComposition();
    const sync = this.sync;
    if (sync) {
      const { doc, selection } = sync.state;
      return toSourceSelection(sync.textModel, doc, selection.from, selection.to);
    }
    return undefined;
  }

  private applySelection(selection: ITextEditorSelection | undefined): void {
    if (!selection) return;
    this.commitComposition();
    const sync = this.sync;
    if (sync) {
      const next = toMarkdownSelection(sync.textModel, sync.state.doc, selection);
      sync.dispatch(sync.state.tr.setSelection(next).scrollIntoView());
    }
  }

  override layout({ width, height }: Dimension): void {
    for (const element of [this.frame, this.error]) {
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    }
  }

  override focus(): void {
    this.pendingFocus = false;
    if (this.view?.editable) {
      this.view.focus();
    } else if (this.view) {
      this.view.dom.focus({ preventScroll: true });
    } else if (!this.error.hidden) {
      this.error.focus();
    } else {
      this.pendingFocus = true;
    }
  }

  override dispose(): void {
    this.clearInput();
    for (const { lifetime } of this.tabModels.values()) {
      lifetime.dispose();
    }
    this.tabModels.clear();
    super.dispose();
    this.frame.remove();
    this.error.remove();
  }
}
