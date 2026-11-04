export type Mat = [number, number, number, number, number, number];
export type Pt = [number, number];
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Geom {
  transform: Mat;
  width: number;
  height: number;
}

/** Same math as pdf.js PageViewport, so overlays line up with pdf.js rendering (and works for blank pages). */
export function pageGeom(view: number[], scale: number, rotation: number): Geom {
  const [x0, y0, x1, y1] = view;
  const cx = (x1 + x0) / 2;
  const cy = (y1 + y0) / 2;
  let a: number, b: number, c: number, d: number;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  let ox: number, oy: number, width: number, height: number;
  if (a === 0) {
    ox = Math.abs(cy - y0) * scale;
    oy = Math.abs(cx - x0) * scale;
    width = (y1 - y0) * scale;
    height = (x1 - x0) * scale;
  } else {
    ox = Math.abs(cx - x0) * scale;
    oy = Math.abs(cy - y0) * scale;
    width = (x1 - x0) * scale;
    height = (y1 - y0) * scale;
  }
  return {
    transform: [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy],
    width,
    height,
  };
}

export function apply(m: Mat, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Mat): Mat {
  const d = m[0] * m[3] - m[1] * m[2];
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}

export function boxFromPts(a: Pt, b: Pt): Box {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

export function unionBoxes(boxes: Box[]): Box {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Rotates vector counterclockwise (PDF y-up space) by deg. */
export function rotVec(x: number, y: number, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.round(Math.cos(r) * 1e9) / 1e9;
  const s = Math.round(Math.sin(r) * 1e9) / 1e9;
  return [x * c - y * s, x * s + y * c];
}

export function matStr(m: Mat) {
  return `matrix(${m.map((v) => +v.toFixed(5)).join(' ')})`;
}
