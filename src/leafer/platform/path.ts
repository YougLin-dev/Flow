import { TAU, clamp, type Point } from "./geometry";

export interface SubPath {
  points: Point[];
  closed: boolean;
}

/** Collects path commands and flattens curves into polylines. */
export class PathRecorder {
  subs: SubPath[] = [];
  current: SubPath | null = null;
  last: Point = { x: 0, y: 0 };
  start: Point = { x: 0, y: 0 };
  /** Whether a current point exists (not the same as an open subpath). */
  private hasCurrent = false;

  begin(): void {
    this.subs = [];
    this.current = null;
    this.hasCurrent = false;
    this.last = { x: 0, y: 0 };
    this.start = { x: 0, y: 0 };
  }

  private ensure(x: number, y: number): SubPath {
    return this.current ?? this.moveTo(x, y);
  }

  moveTo(x: number, y: number): SubPath {
    const sub: SubPath = { points: [{ x, y }], closed: false };
    this.current = sub;
    this.hasCurrent = true;
    this.subs.push(sub);
    this.last = { x, y };
    this.start = { x, y };
    return sub;
  }

  lineTo(x: number, y: number): void {
    if (!this.hasCurrent) {
      // Canvas: lineTo without a current point is a moveTo, not a line.
      this.moveTo(x, y);
      return;
    }
    this.ensure(this.last.x, this.last.y).points.push({ x, y });
    this.last = { x, y };
  }

  closePath(): void {
    const sub = this.current;
    if (!sub) return;
    sub.closed = true;
    const first = sub.points[0];
    sub.points.push({ x: first.x, y: first.y });
    this.current = null;
    this.hasCurrent = true;
    this.last = { x: first.x, y: first.y };
  }

  bezierCurveTo(
    cp1x: number,
    cp1y: number,
    cp2x: number,
    cp2y: number,
    x: number,
    y: number,
  ): void {
    if (!this.hasCurrent) this.moveTo(cp1x, cp1y);
    this.ensure(this.last.x, this.last.y);
    const p0 = this.last;
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * mt * mt * t;
      const c = 3 * mt * t * t;
      const d = t * t * t;
      this.lineTo(a * p0.x + b * cp1x + c * cp2x + d * x, a * p0.y + b * cp1y + c * cp2y + d * y);
    }
  }

  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    if (!this.hasCurrent) this.moveTo(cpx, cpy);
    this.ensure(this.last.x, this.last.y);
    const p0 = this.last;
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const mt = 1 - t;
      this.lineTo(
        mt * mt * p0.x + 2 * mt * t * cpx + t * t * x,
        mt * mt * p0.y + 2 * mt * t * cpy + t * t * y,
      );
    }
  }

  private arcPoints(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    counterclockwise: boolean,
  ): Point[] {
    let delta = end - start;
    if (counterclockwise) {
      if (delta >= 0) delta -= Math.ceil(delta / TAU) * TAU;
      if (delta < -TAU) delta = -TAU;
    } else {
      if (delta <= 0) delta += Math.ceil(-delta / TAU) * TAU;
      if (delta > TAU) delta = TAU;
    }
    if (!delta) return [];
    const steps = Math.max(6, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const points: Point[] = [];
    for (let i = 1; i <= steps; i++) {
      const angle = start + (delta * i) / steps;
      const ex = rx * Math.cos(angle);
      const ey = ry * Math.sin(angle);
      points.push({ x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos });
    }
    return points;
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
  ): void {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const ex = rx * Math.cos(start);
    const ey = ry * Math.sin(start);
    const first = { x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos };
    if (this.hasCurrent) this.lineTo(first.x, first.y);
    else this.moveTo(first.x, first.y);
    const points = this.arcPoints(cx, cy, rx, ry, rotation, start, end, counterclockwise);
    for (const p of points) this.lineTo(p.x, p.y);
  }

  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.appendArc(x, y, radius, radius, 0, startAngle, endAngle, counterclockwise);
  }

  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = false,
  ): void {
    this.appendArc(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise);
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    if (!this.hasCurrent) {
      this.moveTo(x1, y1);
      return;
    }
    const p0 = this.last;
    const v0x = p0.x - x1;
    const v0y = p0.y - y1;
    const v1x = x2 - x1;
    const v1y = y2 - y1;
    const l0 = Math.hypot(v0x, v0y);
    const l1 = Math.hypot(v1x, v1y);
    if (!l0 || !l1 || radius === 0) {
      this.lineTo(x1, y1);
      return;
    }
    const u0 = { x: v0x / l0, y: v0y / l0 };
    const u1 = { x: v1x / l1, y: v1y / l1 };
    const dot = clamp(u0.x * u1.x + u0.y * u1.y, -1, 1);
    // Opposite directions have no bisector and no arc; the spec's path is a
    // straight line to the tangent point.
    if (dot <= -0.999999) {
      this.lineTo(x1, y1);
      return;
    }
    const angle = Math.acos(dot);
    if (!angle) {
      this.lineTo(x1, y1);
      return;
    }
    const distance = Math.abs(radius) / Math.tan(angle / 2);
    const t1 = { x: x1 + u0.x * distance, y: y1 + u0.y * distance };
    const t2 = { x: x1 + u1.x * distance, y: y1 + u1.y * distance };
    this.lineTo(t1.x, t1.y);
    let bx = u0.x + u1.x;
    let by = u0.y + u1.y;
    const bl = Math.hypot(bx, by) || 1;
    bx /= bl;
    by /= bl;
    const centerDistance = Math.abs(radius) / Math.sin(angle / 2);
    const cx = x1 + bx * centerDistance;
    const cy = y1 + by * centerDistance;
    const a0 = Math.atan2(t1.y - cy, t1.x - cx);
    const a1 = Math.atan2(t2.y - cy, t2.x - cx);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= TAU;
    while (sweep < -Math.PI) sweep += TAU;
    const r = Math.abs(radius);
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
    for (let i = 1; i <= steps; i++) {
      const angle2 = a0 + (sweep * i) / steps;
      this.lineTo(cx + r * Math.cos(angle2), cy + r * Math.sin(angle2));
    }
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }

  roundRect(x: number, y: number, w: number, h: number, radii?: number | number[]): void {
    // Canvas' roundRect treats missing or empty radii as square corners, then
    // scales all four corners by one factor if a side's radii do not fit.
    let values: number[] = [0, 0, 0, 0];
    if (typeof radii === "number") {
      values = [radii, radii, radii, radii];
    } else if (radii && radii.length) {
      if (radii.length === 1) values = [radii[0], radii[0], radii[0], radii[0]];
      else if (radii.length === 2) values = [radii[0], radii[1], radii[0], radii[1]];
      else if (radii.length === 3) values = [radii[0], radii[1], radii[2], radii[1]];
      else values = [radii[0], radii[1], radii[2], radii[3]];
    }
    const max = Math.min(Math.abs(w), Math.abs(h)) / 2;
    const r = values.map((value) => clamp(value, 0, max));
    const width = Math.abs(w);
    const height = Math.abs(h);
    const scale = Math.min(
      1,
      width ? width / (r[0] + r[1] || 1) : 1,
      width ? width / (r[3] + r[2] || 1) : 1,
      height ? height / (r[0] + r[3] || 1) : 1,
      height ? height / (r[1] + r[2] || 1) : 1,
    );
    const tl = r[0] * scale;
    const tr = r[1] * scale;
    const br = r[2] * scale;
    const bl = r[3] * scale;
    this.moveTo(x + tl, y);
    this.lineTo(x + w - tr, y);
    if (tr) this.appendArc(x + w - tr, y + tr, tr, tr, 0, -Math.PI / 2, 0, false);
    this.lineTo(x + w, y + h - br);
    if (br) this.appendArc(x + w - br, y + h - br, br, br, 0, 0, Math.PI / 2, false);
    this.lineTo(x + bl, y + h);
    if (bl) this.appendArc(x + bl, y + h - bl, bl, bl, 0, Math.PI / 2, Math.PI, false);
    this.lineTo(x, y + tl);
    if (tl) this.appendArc(x + tl, y + tl, tl, tl, 0, Math.PI, Math.PI * 1.5, false);
    this.closePath();
  }

  /** The path's subpaths, copied. */
  copy(): SubPath[] {
    return this.subs.map((sub) => ({
      points: sub.points.map((p) => ({ x: p.x, y: p.y })),
      closed: sub.closed,
    }));
  }
}
