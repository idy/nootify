import type { LarkRecipient } from './ui-types.js';
import { recipientDisplayName } from './lark-profile.js';

export interface RecipientListOptions {
  current?: string; selected: string; active: string;
  locale: string; currentLabel: string; unknownLabel: string;
  failedAvatars: Set<string>; retainIds: ReadonlySet<string>;
}
interface ContactRow {
  button: HTMLButtonElement; avatar: HTMLSpanElement; initial: HTMLSpanElement;
  name: HTMLSpanElement; secondary: HTMLSpanElement;
  image?: HTMLImageElement; pending?: HTMLImageElement; displayedURL?: string; requestedURL?: string; disposed: boolean;
}

/** Keep row/image identities across polling, streamed batches, search and selection changes. */
export class RecipientListRenderer {
  private readonly rows = new Map<string, ContactRow>();
  constructor(private readonly container: HTMLElement, private readonly scroller: HTMLElement, private readonly select: (id: string) => void) {}

  update(users: readonly LarkRecipient[], options: RecipientListOptions): void {
    const oldScroll = this.scroller.scrollTop;
    const viewport = this.scroller.getBoundingClientRect();
    const anchor = [...this.container.children].find(child => {
      const box = child.getBoundingClientRect(); return box.bottom > viewport.top && box.top < viewport.bottom;
    });
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - viewport.top : 0;
    const focused = this.container.ownerDocument.activeElement as HTMLElement | null;
    const focusInside = !!focused && this.container.contains(focused);
    const names = new Map<string, number>();
    for (const user of users) { const name = recipientDisplayName(user); names.set(name, (names.get(name) ?? 0) + 1); }
    const desired: HTMLButtonElement[] = [];
    for (const user of users) {
      let row = this.rows.get(user.open_id);
      if (!row) { row = this.create(user.open_id); this.rows.set(user.open_id, row); }
      this.updateRow(row, user, (names.get(recipientDisplayName(user)) ?? 0) > 1, options, focusInside);
      desired.push(row.button);
    }
    const visible = new Set<Element>(desired);
    for (const child of [...this.container.children]) if (!visible.has(child)) child.remove();
    let cursor = this.container.firstElementChild;
    for (const button of desired) {
      if (button === cursor) cursor = cursor.nextElementSibling;
      else this.container.insertBefore(button, cursor);
    }
    for (const [id, row] of this.rows) if (!options.retainIds.has(id)) { this.dispose(row); this.rows.delete(id); }
    if (focusInside && focused && this.container.contains(focused) && this.container.ownerDocument.activeElement !== focused) focused.focus({ preventScroll: true });
    if (anchor?.isConnected && visible.has(anchor)) {
      this.scroller.scrollTop += anchor.getBoundingClientRect().top - viewport.top - anchorOffset;
    } else this.scroller.scrollTop = oldScroll;
  }

  clear(): void {
    for (const row of this.rows.values()) this.dispose(row);
    this.rows.clear(); this.container.replaceChildren();
  }

  private create(id: string): ContactRow {
    const doc = this.container.ownerDocument;
    const button = doc.createElement('button'); button.className = 'recipient-person'; button.type = 'button'; button.tabIndex = -1;
    button.id = `recipient-person-${id}`; button.dataset.key = button.id; button.setAttribute('role', 'option');
    const avatar = doc.createElement('span'); avatar.className = 'recipient-avatar'; avatar.setAttribute('aria-hidden', 'true');
    const initial = doc.createElement('span'); avatar.append(initial);
    const main = doc.createElement('span'); main.className = 'recipient-person-main';
    const name = doc.createElement('span'); name.className = 'recipient-person-name';
    const secondary = doc.createElement('span'); secondary.className = 'recipient-person-sub'; main.append(name, secondary);
    const check = doc.createElement('span'); check.className = 'recipient-check'; check.setAttribute('aria-hidden', 'true');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 16 16');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'm3.5 8 3 3 6-6'); svg.append(path); check.append(svg);
    button.append(avatar, main, check); button.addEventListener('click', () => this.select(id));
    return { button, avatar, initial, name, secondary, disposed: false };
  }

  private updateRow(row: ContactRow, user: LarkRecipient, duplicate: boolean, options: RecipientListOptions, focused: boolean): void {
    const name = user.name === user.open_id ? options.unknownLabel : recipientDisplayName(user);
    const secondary = user.open_id === options.current ? options.currentLabel : user.en_name && user.en_name !== user.name ? user.en_name : duplicate || user.name === user.open_id ? `…${user.open_id.slice(-6)}` : '';
    if (row.name.textContent !== name) row.name.textContent = name;
    if (row.secondary.textContent !== secondary) row.secondary.textContent = secondary;
    row.secondary.hidden = !secondary;
    const initial = ([...name.trim()][0] ?? '').toLocaleUpperCase(options.locale);
    if (row.initial.textContent !== initial) row.initial.textContent = initial;
    const title = `${name}\n${user.open_id}`; if (row.button.title !== title) row.button.title = title;
    const selected = String(options.selected === user.open_id);
    if (row.button.getAttribute('aria-selected') !== selected) row.button.setAttribute('aria-selected', selected);
    row.button.classList.toggle('is-active', focused && options.active === user.open_id);
    this.updateAvatar(row, user.avatar_url, options.failedAvatars);
  }

  private updateAvatar(row: ContactRow, url: string | undefined, failed: Set<string>): void {
    if (!url) {
      row.pending?.remove(); row.image?.remove(); row.pending = row.image = undefined;
      row.requestedURL = row.displayedURL = undefined; row.initial.hidden = false; return;
    }
    if (row.displayedURL === url || row.pending && row.requestedURL === url || failed.has(url)) return;
    row.pending?.remove(); row.requestedURL = url;
    const image = this.container.ownerDocument.createElement('img');
    image.alt = ''; image.width = image.height = 36; image.loading = row.image ? 'eager' : 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    image.hidden = !!row.image; row.pending = image;
    const fail = () => {
      if (row.disposed || row.pending !== image && row.image !== image) return;
      if (row.button.isConnected) { if (failed.size >= 500) failed.clear(); failed.add(url); }
      if (row.pending === image) row.pending = undefined;
      if (row.image === image) { row.image = undefined; row.displayedURL = undefined; }
      image.remove(); row.initial.hidden = !!row.image;
    };
    image.addEventListener('error', fail);
    image.addEventListener('load', () => {
      const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve();
      void decoded.then(() => {
        if (row.disposed || row.pending !== image || row.requestedURL !== url) return;
        row.image?.remove(); row.image = image; row.pending = undefined; row.displayedURL = url;
        image.hidden = false; row.initial.hidden = true;
      }, fail);
    });
    image.src = url; row.avatar.append(image);
  }

  private dispose(row: ContactRow): void {
    row.disposed = true; row.pending?.remove(); row.image?.remove(); row.button.remove();
  }
}
