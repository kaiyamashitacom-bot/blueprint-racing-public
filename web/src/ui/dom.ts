// 小さな DOM の道具
export function el(tag: string, attrs: Record<string, string> = {}, ...children: Array<Node | string | null | undefined>): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === "") continue;
    if (k === "class") e.className = v;
    else if (k === "value" && "value" in e) (e as HTMLInputElement).value = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    e.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

export function fitCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  return dpr;
}

/** 変速の印 (AT = オートマ・MT = マニュアル)。分からなければ null (前の記録・コンピューター) */
export function transTag(mt: boolean | undefined | null): HTMLElement | null {
  if (mt === undefined || mt === null) return null;
  const t = el("span", { class: `trans-tag${mt ? " mt" : ""}`, title: mt ? "マニュアル (自分で変速)" : "オートマ" }, mt ? "MT" : "AT");
  return t;
}
