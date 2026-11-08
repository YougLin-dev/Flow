/**
 * Canvas path commands, kept in the snapshot's canvas space.
 *
 * Canvas transforms a path's points when each command is issued, so a command
 * records its points through the CTM in effect at that moment. A fill or
 * stroke then paints that canvas-space path under the CTM in effect at paint
 * time; `commandsUnder` maps it back into the paint's user space, so stroke
 * widths, dashes, gradients and text stay in the space Canvas specifies.
 */
import { applyMatrix, clamp, identity, invert, TAU, type Matrix, type Point } from "../geometry";

export interface PathCommand {
  kind: "M" | "L" | "C" | "Q" | "Z";
  points: Point[];
}

export interface PathBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function pathData(commands: PathCommand[], matrix: Matrix): string {
  const out: string[] = [];
  for (const command of commands) {
    if (command.kind === "Z") {
      out.push("Z");
      continue;
    }
    out.push(command.kind);
    for (const point of command.points) {
      const p = applyMatrix(matrix, point);
      out.push(`${round(p.x)} ${round(p.y)}`);
    }
  }
  return out.join(" ");
}

export function pathBounds(commands: PathCommand[], matrix: Matrix): PathBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const command of commands) {
    for (const point of command.points) {
      const p = applyMatrix(matrix, point);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      any = true;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000 || 0;
}

/** Collects path commands, baking each through its command-time CTM. */
export class PathCommands {
  readonly commands: PathCommand[] = [];
  private last: Point = { x: 0, y: 0 };
  private start: Point = { x: 0, y: 0 };
  private hasCurrent = false;

  begin(): void {
    this.commands.length = 0;
    this.hasCurrent = false;
    this.last = { x: 0, y: 0 };
    this.start = { x: 0, y: 0 };
  }

  moveTo(x: number, y: number, ctm: Matrix): void {
    const p = applyMatrix(ctm, { x, y });
    this.commands.push({ kind: "M", points: [p] });
    this.last = p;
    this.start = p;
    this.hasCurrent = true;
  }

  lineTo(x: number, y: number, ctm: Matrix): void {
    if (!this.hasCurrent) {
      this.moveTo(x, y, ctm);
      return;
    }
    const p = applyMatrix(ctm, { x, y });
    this.commands.push({ kind: "L", points: [p] });
    this.last = p;
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
    ctm: Matrix,
  ): void {
    if (!this.hasCurrent) this.moveTo(cp1x, cp1y, ctm);
    const [c1, c2, end] = [
      applyMatrix(ctm, { x: cp1x, y: cp1y }),
      applyMatrix(ctm, { x: cp2x, y: cp2y }),
      applyMatrix(ctm, { x, y }),
    ];
    this.commands.push({ kind: "C", points: [c1, c2, end] });
    this.last = end;
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number, ctm: Matrix): void {
    if (!this.hasCurrent) this.moveTo(cpx, cpy, ctm);
    const [control, end] = [applyMatrix(ctm, { x: cpx, y: cpy }), applyMatrix(ctm, { x, y })];
    this.commands.push({ kind: "Q", points: [control, end] });
    this.last = end;
  }

  closePath(): void {
    if (!this.hasCurrent) return;
    if (this.commands.length) this.commands.push({ kind: "Z", points: [] });
    this.last = this.start;
    this.hasCurrent = true;
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise: boolean,
    ctm: Matrix,
  ): void {
    this.appendArc(x, y, radius, radius, 0, startAngle, endAngle, counterclockwise, ctm);
  }

  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise: boolean,
    ctm: Matrix,
  ): void {
    this.appendArc(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise, ctm);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number, ctm: Matrix): void {
    if (!this.hasCurrent) {
      this.moveTo(x1, y1, ctm);
      return;
    }
    // The current point is in canvas space; the tangent points arrive in
    // the current user space, so the geometry is done there.
    const p0 = applyMatrix(invert(ctm) ?? identity(), this.last);
    const v0x = p0.x - x1;
    const v0y = p0.y - y1;
    const v1x = x2 - x1;
    const v1y = y2 - y1;
    const l0 = Math.hypot(v0x, v0y);
    const l1 = Math.hypot(v1x, v1y);
    if (!l0 || !l1 || radius === 0) {
      this.lineTo(x1, y1, ctm);
      return;
    }
    const u0 = { x: v0x / l0, y: v0y / l0 };
    const u1 = { x: v1x / l1, y: v1y / l1 };
    const dot = clamp(u0.x * u1.x + u0.y * u1.y, -1, 1);
    if (dot <= -0.999_999) {
      this.lineTo(x1, y1, ctm);
      return;
    }
    const angle = Math.acos(dot);
    if (!angle) {
      this.lineTo(x1, y1, ctm);
      return;
    }
    const distance = Math.abs(radius) / Math.tan(angle / 2);
    const t1 = { x: x1 + u0.x * distance, y: y1 + u0.y * distance };
    const t2 = { x: x1 + u1.x * distance, y: y1 + u1.y * distance };
    this.lineTo(t1.x, t1.y, ctm);
    const bx = u0.x + u1.x;
    const by = u0.y + u1.y;
    const bl = Math.hypot(bx, by) || 1;
    const centerDistance = Math.abs(radius) / Math.sin(angle / 2);
    const cx = x1 + (bx / bl) * centerDistance;
    const cy = y1 + (by / bl) * centerDistance;
    const a0 = Math.atan2(t1.y - cy, t1.x - cx);
    const a1 = Math.atan2(t2.y - cy, t2.x - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= TAU;
    while (sweep < -Math.PI) sweep += TAU;
    const r = Math.abs(radius);
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
    for (let i = 1; i <= steps; i++) {
      const a = a0 + (sweep * i) / steps;
      this.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a), ctm);
    }
  }

  rect(x: number, y: number, w: number, h: number, ctm: Matrix): void {
    this.moveTo(x, y, ctm);
    this.lineTo(x + w, y, ctm);
    this.lineTo(x + w, y + h, ctm);
    this.lineTo(x, y + h, ctm);
    this.closePath();
  }

  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radii: number | number[] | undefined,
    ctm: Matrix,
  ): void {
    const r = cornerRadii(radii, w, h);
    this.moveTo(x + r[0], y, ctm);
    this.lineTo(x + w - r[1], y, ctm);
    if (r[1]) this.appendArc(x + w - r[1], y + r[1], r[1], r[1], 0, -Math.PI / 2, 0, false, ctm);
    this.lineTo(x + w, y + h - r[2], ctm);
    if (r[2]) this.appendArc(x + w - r[2], y + h - r[2], r[2], r[2], 0, 0, Math.PI / 2, false, ctm);
    this.lineTo(x + r[3], y + h, ctm);
    if (r[3])
      this.appendArc(x + r[3], y + h - r[3], r[3], r[3], 0, Math.PI / 2, Math.PI, false, ctm);
    this.lineTo(x, y + r[0], ctm);
    if (r[0]) this.appendArc(x + r[0], y + r[0], r[0], r[0], 0, Math.PI, Math.PI * 1.5, false, ctm);
    this.closePath();
  }

  private appendArc(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    counterclockwise: boolean,
    ctm: Matrix,
  ): void {
    let delta = end - start;
    if (counterclockwise) {
      if (delta >= 0) delta -= Math.ceil(delta / TAU) * TAU;
      if (delta < -TAU) delta = -TAU;
    } else {
      if (delta <= 0) delta += Math.ceil(-delta / TAU) * TAU;
      if (delta > TAU) delta = TAU;
    }
    if (!delta) return;
    const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 36)));
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (let i = 0; i <= steps; i++) {
      const angle = start + (delta * i) / steps;
      const ex = rx * Math.cos(angle);
      const ey = ry * Math.sin(angle);
      const x = cx + ex * cos - ey * sin;
      const y = cy + ex * sin + ey * cos;
      if (i === 0) {
        if (this.hasCurrent) this.lineTo(x, y, ctm);
        else this.moveTo(x, y, ctm);
      } else this.lineTo(x, y, ctm);
    }
  }
}

function cornerRadii(radii: number | number[] | undefined, w: number, h: number): number[] {
  let values: number[] = [0, 0, 0, 0];
  if (typeof radii === "number") values = [radii, radii, radii, radii];
  else if (radii && radii.length) {
    if (radii.length === 1) values = [radii[0], radii[0], radii[0], radii[0]];
    else if (radii.length === 2) values = [radii[0], radii[1], radii[0], radii[1]];
    else if (radii.length === 3) values = [radii[0], radii[1], radii[2], radii[1]];
    else values = [radii[0], radii[1], radii[2], radii[3]];
  }
  const r = values.map((value) => Math.max(0, value));
  const width = Math.abs(w);
  const height = Math.abs(h);
  const scale = Math.min(
    1,
    width ? width / (r[0] + r[1] || 1) : 1,
    width ? width / (r[3] + r[2] || 1) : 1,
    height ? height / (r[0] + r[3] || 1) : 1,
    height ? height / (r[1] + r[2] || 1) : 1,
  );
  return r.map((value) => value * scale);
}
