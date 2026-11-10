let nextDropdownId = 0;

/** A button-focused select whose listbox can escape clipping settings groups. */
export class Dropdown {
  private options: HTMLButtonElement[] = [];
  private active?: HTMLButtonElement;
  private opened = false;
  private search = '';
  private searchedAt = 0;
  private readonly doc: Document;

  constructor(private readonly button: HTMLButtonElement, private readonly menu: HTMLElement) {
    this.doc = button.ownerDocument;
    button.type = 'button';
    button.id ||= this.uniqueId('dropdown');
    menu.id ||= this.uniqueId(`${button.id}-menu`);
    button.classList.add('dropdown-button');
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-controls', menu.id);
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    menu.classList.add('dropdown-menu');
    menu.setAttribute('role', 'listbox');
    if (!menu.hasAttribute('aria-label') && !menu.hasAttribute('aria-labelledby')) menu.setAttribute('aria-labelledby', button.id);
    menu.hidden = true;
    this.doc.body.append(menu);
    button.addEventListener('click', () => {
      if (this.disabled(button)) return;
      if (this.opened) this.close(); else this.open();
    });
    button.addEventListener('change', () => this.refresh());
    button.addEventListener('keydown', event => this.keydown(event));
    menu.addEventListener('keydown', event => this.keydown(event));
    menu.addEventListener('pointerdown', event => {
      if (this.optionFrom(event.target)) event.preventDefault();
    });
    menu.addEventListener('pointermove', event => {
      const option = this.optionFrom(event.target);
      if (this.opened && option && !this.disabled(option)) this.setActive(option);
    });
    menu.addEventListener('click', event => {
      const option = this.optionFrom(event.target);
      if (option) this.choose(option);
    });
    this.refresh();
  }

  get value(): string { return this.button.value; }
  set value(value: string) { this.button.value = value; this.refresh(); }

  /** Re-read live option labels after translation or a programmatic value update. */
  refresh(): void {
    this.options = [...this.menu.querySelectorAll<HTMLButtonElement>('button[role="option"][data-value]')];
    for (const option of this.options) {
      option.id ||= this.uniqueId(`${this.menu.id}-option`);
      option.type = 'button'; option.tabIndex = -1;
      option.classList.add('dropdown-option');
      option.setAttribute('aria-selected', String(option.dataset.value === this.value));
    }
    const selected = this.options.find(option => option.dataset.value === this.value);
    const label = this.button.querySelector('[data-dropdown-label]');
    if (label) label.textContent = selected ? this.label(selected) : '';
    if (this.opened && (this.disabled(this.button) || !this.enabled().length)) this.close();
    this.setActive(this.opened ? this.enabled().find(option => option === this.active) ?? this.enabled().find(option => option === selected) ?? this.enabled()[0] : undefined);
    if (this.opened) this.position();
  }

  /** Dismiss without committing the highlighted option; outside dismissal keeps focus. */
  close(restoreFocus = false): void {
    this.opened = false;
    this.menu.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.setActive(undefined);
    this.search = ''; this.searchedAt = 0;
    this.listen(false);
    if (restoreFocus && !this.disabled(this.button)) this.button.focus({ preventScroll: true });
  }

  private uniqueId(prefix: string): string {
    let id: string;
    do { id = `${prefix}-${++nextDropdownId}`; } while (this.doc.getElementById(id));
    return id;
  }

  private disabled(option: HTMLButtonElement): boolean {
    return option.disabled || option.getAttribute('aria-disabled') === 'true' || Boolean(option.hidden);
  }

  private enabled(): HTMLButtonElement[] { return this.options.filter(option => !this.disabled(option)); }
  private label(option: HTMLButtonElement): string { return (option.querySelector('[data-option-label]')?.textContent ?? option.textContent ?? '').trim(); }

  private optionFrom(target: EventTarget | null): HTMLButtonElement | undefined {
    const option = (target as Element | null)?.closest?.('button[role="option"][data-value]') as HTMLButtonElement | null;
    return option && this.options.includes(option) ? option : undefined;
  }

  private open(edge?: 'first' | 'last'): void {
    if (this.disabled(this.button)) return;
    this.refresh();
    const options = this.enabled();
    if (!options.length) return;
    this.opened = true;
    this.menu.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.position();
    this.setActive(edge === 'first' ? options[0] : edge === 'last' ? options.at(-1) : options.find(option => option.dataset.value === this.value) ?? options[0], true);
    this.listen(true);
  }

  private setActive(option?: HTMLButtonElement, scroll = false): void {
    this.active = option;
    for (const candidate of this.options) {
      if (candidate === option) candidate.setAttribute('data-active', 'true');
      else candidate.removeAttribute('data-active');
    }
    if (option) this.button.setAttribute('aria-activedescendant', option.id);
    else this.button.removeAttribute('aria-activedescendant');
    if (option && scroll) {
      const row = option.getBoundingClientRect(), box = this.menu.getBoundingClientRect();
      if (row.top < box.top) this.menu.scrollTop -= box.top - row.top;
      else if (row.bottom > box.bottom) this.menu.scrollTop += row.bottom - box.bottom;
    }
  }

  private choose(option: HTMLButtonElement): void {
    if (!this.opened || this.disabled(this.button) || this.disabled(option)) return;
    const changed = this.value !== option.dataset.value;
    this.value = option.dataset.value!;
    this.close(true);
    if (changed) {
      const event = this.doc.createEvent('Event');
      event.initEvent('change', true, false);
      this.button.dispatchEvent(event);
    }
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || this.disabled(this.button)) return;
    const key = event.key;
    if (key === 'Tab') {
      if (this.opened) { event.stopPropagation(); this.close(); }
      return;
    }
    const printable = key?.length === 1 && key !== ' ';
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Spacebar', 'Escape'].includes(key) && !printable) return;
    event.preventDefault(); event.stopPropagation();
    if (key === 'Escape') { this.close(true); return; }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (this.opened && this.active) this.choose(this.active); else this.open();
      return;
    }
    if (key === 'Home' || key === 'End') {
      if (!this.opened) this.open(key === 'Home' ? 'first' : 'last');
      else this.setActive(key === 'Home' ? this.enabled()[0] : this.enabled().at(-1), true);
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (!this.opened) { this.open(key === 'ArrowUp' && !this.enabled().some(option => option.dataset.value === this.value) ? 'last' : undefined); return; }
      const options = this.enabled(), index = options.indexOf(this.active!);
      this.setActive(options[(index + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length], true);
      return;
    }
    const now = Date.now(), letter = key.toLocaleLowerCase();
    this.search = now - this.searchedAt > 700 ? letter : this.search + letter;
    this.searchedAt = now;
    if (!this.opened) this.open();
    const options = this.enabled(), index = options.indexOf(this.active!);
    const repeated = [...this.search].every(character => character === letter);
    const prefix = repeated ? letter : this.search;
    const ordered = [...options.slice(index + (repeated ? 1 : 0)), ...options.slice(0, index + (repeated ? 1 : 0))];
    const match = ordered.find(option => this.label(option).toLocaleLowerCase().startsWith(prefix));
    if (match) this.setActive(match, true);
  }

  private readonly outside = (event: Event): void => {
    const target = event.target as Node | null;
    if (target?.nodeType && !this.button.contains(target) && !this.menu.contains(target)) this.close();
  };
  private readonly dismiss = (): void => { this.close(); };
  private readonly scroll = (event: Event): void => {
    const target = event.target as Node | null;
    if (target?.nodeType && this.menu.contains(target)) return;
    if (!target?.nodeType || target.contains(this.button)) this.close();
  };

  private listen(add: boolean): void {
    const method = add ? 'addEventListener' : 'removeEventListener';
    this.doc[method]('pointerdown', this.outside, true);
    this.doc[method]('click', this.outside, true);
    this.doc[method]('focusin', this.outside, true);
    this.doc[method]('scroll', this.scroll, true);
    const view = this.doc.defaultView;
    view?.[method]('scroll', this.scroll, true);
    view?.[method]('resize', this.dismiss);
    view?.[method]('hashchange', this.dismiss);
    view?.[method]('popstate', this.dismiss);
  }

  private position(): void {
    const margin = 8, gap = 4, view = this.doc.defaultView;
    const viewportWidth = this.doc.documentElement.clientWidth || view?.innerWidth || 0;
    const viewportHeight = this.doc.documentElement.clientHeight || view?.innerHeight || 0;
    const anchor = this.button.getBoundingClientRect(), style = this.menu.style;
    style.position = 'fixed'; style.boxSizing = 'border-box';
    style.maxWidth = `${Math.max(0, viewportWidth - margin * 2)}px`;
    style.minWidth = `${Math.min(anchor.width, Math.max(0, viewportWidth - margin * 2))}px`;
    style.maxHeight = `${Math.max(0, viewportHeight - margin * 2)}px`;
    const box = this.menu.getBoundingClientRect();
    const width = Math.min(Math.max(anchor.width, box.width), Math.max(0, viewportWidth - margin * 2));
    const height = Math.max(box.height, this.menu.scrollHeight || 0);
    const below = Math.max(0, viewportHeight - margin - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - gap - margin);
    const flip = height > below && above > below;
    const available = Math.min(flip ? above : below, Math.max(0, viewportHeight - margin * 2));
    const visibleHeight = Math.min(height, available);
    style.maxHeight = `${available}px`;
    style.left = `${Math.max(margin, Math.min(anchor.left, viewportWidth - margin - width))}px`;
    style.top = `${Math.max(margin, Math.min(flip ? anchor.top - gap - visibleHeight : anchor.bottom + gap, viewportHeight - margin - visibleHeight))}px`;
  }
}
