/** Minimal runtime substitute for the portions of Obsidian used by state-store tests. */
export class TFile {
  constructor(public readonly path: string) {}
}
export class TFolder {}

export class App {
  private readonly localStorage = new Map<string, unknown>();
  vault = {
    adapter: {
      exists: async (): Promise<boolean> => true,
      read: async (): Promise<string> => "",
      write: async (): Promise<void> => undefined,
      mkdir: async (): Promise<void> => undefined,
    },
    getAbstractFileByPath: (): null => null,
  };
  workspace = { getLeaf: () => ({ openFile: async (): Promise<void> => undefined }) };
  loadLocalStorage(key: string): unknown { return this.localStorage.get(key); }
  saveLocalStorage(key: string, value: unknown): void { this.localStorage.set(key, value); }
}
export class Component {
  private cleanups: (() => void)[] = [];
  load(): void {}
  register(cleanup: () => void): void { this.cleanups.push(cleanup); }
  unload(): void { for (const cleanup of this.cleanups.splice(0)) cleanup(); }
}
export class WorkspaceLeaf {}
export class ItemView extends Component {
  app = new App();
  containerEl = {} as HTMLElement;
  constructor(_leaf?: WorkspaceLeaf) { super(); }
}
export class Modal extends Component {
  contentEl = {} as HTMLElement;
  constructor(public app: App) { super(); }
  open(): void {}
  close(): void { this.onClose(); }
  onClose(): void {}
}
export class Notice {
  constructor(_message: string) {}
}
export class PluginSettingTab {
  containerEl: HTMLElement;
  constructor(public app: App, public plugin: unknown) {
    this.containerEl = globalThis.document?.createElement("div") ?? {} as HTMLElement;
  }
}
class ButtonComponent {
  constructor(readonly buttonEl: HTMLButtonElement) {}
  setButtonText(value: string): this { this.buttonEl.textContent = value; return this; }
  setCta(): this { return this; }
  setDisabled(value: boolean): this { this.buttonEl.disabled = value; return this; }
  onClick(callback: () => void | Promise<void>): this { this.buttonEl.addEventListener("click", () => { void callback(); }); return this; }
}
class TextComponent {
  readonly inputEl: HTMLInputElement;
  constructor(parent: HTMLElement) { this.inputEl = parent.createEl("input") as HTMLInputElement; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(_callback: (value: string) => void | Promise<void>): this { return this; }
}
class ToggleComponent {
  setValue(_value: boolean): this { return this; }
  onChange(_callback: (value: boolean) => void | Promise<void>): this { return this; }
}
class DropdownComponent {
  addOptions(_options: Record<string, string>): this { return this; }
  setValue(_value: string): this { return this; }
  onChange(_callback: (value: string) => void | Promise<void>): this { return this; }
}
export class Setting {
  settingEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  constructor(parent: HTMLElement) {
    this.settingEl = parent.createDiv({ cls: "setting-item" });
    this.nameEl = this.settingEl.createDiv({ cls: "setting-item-name" });
  }
  setName(value: string): this { this.nameEl.textContent = value; return this; }
  setDesc(value: string): this { this.settingEl.createDiv({ cls: "setting-item-description", text: value }); return this; }
  setHeading(): this { this.settingEl.addClass("setting-item-heading"); return this; }
  addButton(callback: (button: ButtonComponent) => unknown): this {
    callback(new ButtonComponent(this.settingEl.createEl("button") as HTMLButtonElement));
    return this;
  }
  addText(callback: (text: TextComponent) => unknown): this { callback(new TextComponent(this.settingEl)); return this; }
  addToggle(callback: (toggle: ToggleComponent) => unknown): this { callback(new ToggleComponent()); return this; }
  addDropdown(callback: (dropdown: DropdownComponent) => unknown): this { callback(new DropdownComponent()); return this; }
}
export class AbstractInputSuggest<T> {
  constructor(_app: App, _inputEl: HTMLInputElement) {}
  getSuggestions(_query: string): T[] { return []; }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  selectSuggestion(_value: T): void {}
}
export const MarkdownRenderer = {
  async render(_app: App, text: string, element: HTMLElement): Promise<void> {
    element.textContent = text;
  },
};
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const fragment = globalThis.document?.createDocumentFragment();
  if (!fragment) return {} as DocumentFragment;
  const template = globalThis.document.createElement("template");
  template.innerHTML = html;
  fragment.appendChild(template.content);
  return fragment;
}
export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is unavailable in tests");
}
