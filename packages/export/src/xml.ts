/**
 * Minimal XML-serialisering.
 *
 * Ingen avhengighet: SAF-T er en fast, kjent trestruktur uten namespaces per
 * node, uten attributter og uten CDATA. Et helt XML-bibliotek for det ville
 * vært mer kode å holde oppdatert enn dette.
 *
 * Escapingen er ikke valgfri: et leverandørnavn som «Rørlegger & Sønn AS»
 * lager ugyldig XML uten den, og da avvises hele filen av mottakeren.
 */

export type XmlValue = string | number | null | undefined;
export type XmlNode = { tag: string; children?: XmlNode[]; value?: XmlValue };

/** Kontrolltegn er ulovlige i XML 1.0, og de finnes i tekst hentet fra PDF. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(CONTROL_CHARS, "");
}

export function el(tag: string, value: XmlValue): XmlNode {
  return { tag, value };
}

export function node(tag: string, children: (XmlNode | null | undefined)[]): XmlNode {
  return { tag, children: children.filter((c): c is XmlNode => Boolean(c)) };
}

export function render(nodes: XmlNode[], indent = 0): string {
  const pad = "  ".repeat(indent);
  return nodes
    .map((n) => {
      if (n.children) {
        if (n.children.length === 0) return `${pad}<${n.tag}/>`;
        return `${pad}<${n.tag}>\n${render(n.children, indent + 1)}\n${pad}</${n.tag}>`;
      }
      // Tomme felter blir selvlukkende i stedet for å forsvinne: SAF-T har
      // påkrevde elementer som må stå der selv når vi ikke har verdien.
      if (n.value === null || n.value === undefined) return `${pad}<${n.tag}/>`;
      return `${pad}<${n.tag}>${escapeXml(String(n.value))}</${n.tag}>`;
    })
    .join("\n");
}

export function document(root: XmlNode, attributes: Record<string, string>): string {
  const attrs = Object.entries(attributes)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  const inner = root.children ? render(root.children, 1) : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root.tag}${attrs}>\n${inner}\n</${root.tag}>\n`;
}
