/** Tiny safe DOM helpers. All text goes through `textContent`; never `innerHTML`. */

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

export function describeRule(rule: { type: string; value: string; includeSubdomains: boolean }): string {
  if (rule.type === "domain") return rule.includeSubdomains ? `${rule.value} (and subdomains)` : rule.value;
  return `${rule.value}… (URL prefix)`;
}
