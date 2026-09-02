/**
 * The only way this client puts anything on the page. Every helper writes
 * `textContent`, so server data can never become markup (ADR 0006).
 */

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

export function el(tag: string, content?: string): HTMLElement {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  return element;
}

export function text(content: string): Text {
  return document.createTextNode(content);
}

export function setText(element: HTMLElement, content: string): void {
  element.textContent = content;
}

export function setVisible(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}
