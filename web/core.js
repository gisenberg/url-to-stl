import QRCode from 'qrcode';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import FONT_AWESOME_DATA from '../assets/fontawesome-brands.json' with { type: 'json' };

export class InputError extends Error {}

const encoder = new TextEncoder();
const TOKEN_SHAPES = new Set(['circle', 'square', 'rectangle', 'pentagon', 'hexagon']);
const CORNER_STYLES = new Set(['default', 'sharp', 'softened', 'rounded', 'custom']);
const EDGE_PROFILES = new Set(['straight', 'chamfered', 'rounded', 'inset', 'tapered']);
const TOKEN_PRESETS = new Set(['custom', 'business-card']);
const TOKEN_ICONS = new Set(['none', 'instagram', 'x', 'facebook', 'linkedin', 'youtube', 'tiktok']);
const QR_MODULE_STYLES = new Set(['square', 'rounded', 'dots', 'faceted', 'triangle', 'lines']);
const QR_FINDER_STYLES = new Set(['square', 'rounded', 'circle']);
const QR_FINDER_CENTER_STYLES = new Set(['square', 'rounded', 'circle', 'diamond']);
const QR_OUTER_FRAMES = new Set(['none', 'outline']);
const QR_CENTER_ICONS = new Set(['none', 'blank', 'instagram', 'x', 'facebook', 'linkedin', 'youtube', 'tiktok']);

function number(data, key, fallback, minimum, maximum) {
  const raw = data[key] === undefined || data[key] === '' ? fallback : data[key];
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new InputError(`${label(key)} must be a number.`);
  if (value < minimum || value > maximum) {
    throw new InputError(`${label(key)} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function measurementMm(data, key, fallback, minimum, maximum) {
  const unit = data[`${key}_unit`] || 'mm';
  if (!['mm', 'in'].includes(unit)) throw new InputError(`${label(key)} unit must be millimeters or inches.`);
  const raw = data[key] === undefined || data[key] === '' ? (unit === 'mm' ? fallback : fallback / 25.4) : data[key];
  let value = Number(raw);
  if (!Number.isFinite(value)) throw new InputError(`${label(key)} must be a number.`);
  if (unit === 'in') value *= 25.4;
  if (value < minimum || value > maximum) {
    throw new InputError(`${label(key)} must be between ${minimum} and ${maximum} mm.`);
  }
  return round(value);
}

function label(key) {
  const text = key.replaceAll('_', ' ');
  return text[0].toUpperCase() + text.slice(1);
}

function color(data, key, fallback) {
  const value = data[key] || fallback;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new InputError('Colors must be six-digit hex values.');
  }
  return value.toUpperCase();
}

function luminance(hex) {
  const values = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = values.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string') throw new InputError('Enter a website URL.');
  let value = raw.trim();
  if (!value || encoder.encode(value).length > 1500 || [...value].some(char => /\s/.test(char) || char.codePointAt(0) < 32)) {
    throw new InputError('Enter a URL without spaces, up to 1,500 UTF-8 bytes.');
  }
  if (!value.includes('://')) value = `https://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InputError('Enter a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /[<>"{}|\\^`]/.test(value)) {
    throw new InputError('Enter a valid HTTP or HTTPS URL without credentials.');
  }
  return value;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function regularPolygon(sides, width, startAngle) {
  const points = Array.from({ length: sides }, (_, index) => {
    const angle = startAngle + Math.PI * 2 * index / sides;
    return [Math.cos(angle), Math.sin(angle)];
  });
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const scale = width / (Math.max(...xs) - Math.min(...xs));
  const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
  return points.map(([x, y]) => [round((x - centerX) * scale), round((y - centerY) * scale)]);
}

function roundedPolygon(points, radius, segments = 8) {
  const rounded = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const previous = points[(index + points.length - 1) % points.length];
    const following = points[(index + 1) % points.length];
    const incomingLength = Math.hypot(previous[0] - point[0], previous[1] - point[1]);
    const outgoingLength = Math.hypot(following[0] - point[0], following[1] - point[1]);
    const incoming = [(previous[0] - point[0]) / incomingLength, (previous[1] - point[1]) / incomingLength];
    const outgoing = [(following[0] - point[0]) / outgoingLength, (following[1] - point[1]) / outgoingLength];
    const angle = Math.acos(Math.max(-1, Math.min(1, incoming[0] * outgoing[0] + incoming[1] * outgoing[1])));
    const tangent = Math.min(radius / Math.tan(angle / 2), incomingLength * .45, outgoingLength * .45);
    const actualRadius = tangent * Math.tan(angle / 2);
    const bisector = [incoming[0] + outgoing[0], incoming[1] + outgoing[1]];
    const bisectorLength = Math.hypot(...bisector);
    const centerDistance = actualRadius / Math.sin(angle / 2);
    const center = [
      point[0] + bisector[0] / bisectorLength * centerDistance,
      point[1] + bisector[1] / bisectorLength * centerDistance,
    ];
    const start = Math.atan2(point[1] + incoming[1] * tangent - center[1], point[0] + incoming[0] * tangent - center[0]);
    let end = Math.atan2(point[1] + outgoing[1] * tangent - center[1], point[0] + outgoing[0] * tangent - center[0]);
    while (end <= start) end += Math.PI * 2;
    for (let step = 0; step < segments; step++) {
      const angleAtStep = start + (end - start) * step / segments;
      rounded.push([round(center[0] + actualRadius * Math.cos(angleAtStep)), round(center[1] + actualRadius * Math.sin(angleAtStep))]);
    }
  }
  return rounded;
}

function normalizeOutline(outline, width, height) {
  const dimensions = outlineDimensions(outline);
  return outline.map(([x, y]) => [round(x * width / dimensions.width), round(y * height / dimensions.height)]);
}

function shapeOutline(shape, width, height = width, cornerStyle = 'default', cornerRadius = 4) {
  if (shape === 'circle') {
    return Array.from({ length: 256 }, (_, index) => {
      const angle = Math.PI * 2 * index / 256;
      return [round(width / 2 * Math.cos(angle)), round(width / 2 * Math.sin(angle))];
    });
  }
  let points;
  if (['square', 'rectangle'].includes(shape)) {
    points = [[width / 2, height / 2], [-width / 2, height / 2], [-width / 2, -height / 2], [width / 2, -height / 2]];
  } else {
    points = regularPolygon(shape === 'pentagon' ? 5 : 6, width, shape === 'pentagon' ? Math.PI / 2 : 0);
  }
  if (cornerStyle === 'sharp' || (cornerStyle === 'default' && ['pentagon', 'hexagon'].includes(shape))) return points;
  let radius;
  if (cornerStyle === 'default') {
    radius = Math.min(shape === 'square' ? 4 : 5, (shape === 'square' ? width : height) * (shape === 'square' ? .07 : .1));
  } else if (cornerStyle === 'softened') radius = Math.min(1.2, width * .03);
  else if (cornerStyle === 'rounded') radius = Math.min(4, width * .08);
  else radius = cornerRadius;
  return normalizeOutline(roundedPolygon(points, radius), width, height);
}

function outlineDimensions(outline) {
  const xs = outline.map(point => point[0]);
  const ys = outline.map(point => point[1]);
  return { width: round(Math.max(...xs) - Math.min(...xs)), height: round(Math.max(...ys) - Math.min(...ys)) };
}

function insetOutline(outline, width, height, inset) {
  if (inset <= 0) return outline;
  return outline.map(([x, y]) => [
    round(x * (width - 2 * inset) / width),
    round(y * (height - 2 * inset) / height),
  ]);
}

function moduleSizeForOutline(outline, modules, centerX = 0, centerY = 0, clearance = 1) {
  let qrHalf = Infinity;
  for (let index = 0; index < outline.length; index++) {
    const [ax, ay] = outline[index];
    const [bx, by] = outline[(index + 1) % outline.length];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    const distance = Math.abs(dx * (centerY - ay) - dy * (centerX - ax)) / length;
    const squareProjection = (Math.abs(dx) + Math.abs(dy)) / length;
    qrHalf = Math.min(qrHalf, (distance - clearance) / squareProjection);
  }
  return Math.max(0, 2 * qrHalf / (modules + 8));
}

function moduleSizeForShape(shape, width, height, modules, cornerStyle = 'default', perimeterInset = 0, clearance = 1, cornerRadius = 4) {
  const outline = shapeOutline(shape, width, height, cornerStyle, cornerRadius);
  return moduleSizeForOutline(insetOutline(outline, width, height, perimeterInset), modules, 0, 0, clearance);
}

function minimumShapeWidth(shape, modules, minimumModule, cornerStyle = 'default', perimeterInset = 0, clearance = 1, cornerRadius = 4) {
  let low = 25;
  let high = 200;
  if (moduleSizeForShape(shape, high, high, modules, cornerStyle, perimeterInset, clearance, cornerRadius) < minimumModule) return Infinity;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (low + high) / 2;
    if (moduleSizeForShape(shape, middle, middle, modules, cornerStyle, perimeterInset, clearance, cornerRadius) >= minimumModule) high = middle;
    else low = middle;
  }
  return Math.ceil(high - 1e-7);
}

function edgeSlices(profile, size, base) {
  if (profile === 'straight') return [[0, 0], [base, 0]];
  let slices;
  if (profile === 'chamfered') {
    const height = Math.min(size, base * .8);
    slices = [[0, size], [height, 0]];
  } else if (profile === 'rounded') {
    const height = Math.min(size, base * .8);
    slices = Array.from({ length: 7 }, (_, step) => [
      round(height * Math.sin(Math.PI / 2 * step / 6)),
      round(size * Math.cos(Math.PI / 2 * step / 6)),
    ]);
  } else if (profile === 'inset') {
    const height = Math.min(.4, base * .5);
    slices = [[0, size], [height, size], [height, 0]];
  } else slices = [[0, size], [base, 0]];
  if (slices.at(-1)[0] < base - 1e-7) slices.push([base, 0]);
  return slices;
}

function topEdgeSlices(profile, size, height) {
  if (profile === 'straight') return [[0, 0], [height, 0]];
  let slices;
  if (profile === 'chamfered') {
    const effect = Math.min(size, height * .8);
    slices = [[0, 0], [height - effect, 0], [height, size]];
  } else if (profile === 'rounded') {
    const effect = Math.min(size, height * .8);
    slices = Array.from({ length: 7 }, (_, step) => {
      const angle = Math.PI / 2 * step / 6;
      return [round(height - effect + effect * Math.sin(angle)), round(size * (1 - Math.cos(angle)))];
    });
    if (slices[0][0] > 1e-7) slices.unshift([0, 0]);
  } else if (profile === 'inset') {
    const effect = Math.min(.4, height * .5);
    slices = [[0, 0], [height - effect, 0], [height - effect, size], [height, size]];
  } else {
    slices = [[0, 0], [height, size]];
  }
  return slices;
}

function combinedBaseSlices(bottomProfile, bottomSize, topProfile, topSize, height) {
  if (topProfile === 'straight') return edgeSlices(bottomProfile, bottomSize, height);
  if (bottomProfile === 'straight') return topEdgeSlices(topProfile, topSize, height);
  const lowerHeight = height / 2;
  const upperHeight = height - lowerHeight;
  const lower = edgeSlices(bottomProfile, bottomSize, lowerHeight);
  const upper = topEdgeSlices(topProfile, topSize, upperHeight)
    .map(([z, inset]) => [round(z + lowerHeight), inset]);
  return [...lower, ...upper.slice(1)];
}

function rectangleOutline(cx, cy, width, height) {
  return [
    [cx + width / 2, cy + height / 2], [cx - width / 2, cy + height / 2],
    [cx - width / 2, cy - height / 2], [cx + width / 2, cy - height / 2],
  ].map(point => point.map(value => round(value)));
}

function circleOutline(cx, cy, radius, segments = 32) {
  return Array.from({ length: segments }, (_, index) => {
    const angle = Math.PI * 2 * index / segments;
    return [round(cx + radius * Math.cos(angle)), round(cy + radius * Math.sin(angle))];
  });
}

function iconOutlines(icon, centerX, centerY, size) {
  if (icon === 'none') return [];
  return FONT_AWESOME_DATA.icons[icon].outlines.map(outline => outline.map(([x, y]) =>
    [round(centerX + x * size), round(centerY + y * size)]));
}

function roundedRectangleOutline(cx, cy, width, height, radius, segments = 4) {
  const points = [];
  const corners = [
    [cx + width / 2 - radius, cy + height / 2 - radius, 0],
    [cx - width / 2 + radius, cy + height / 2 - radius, Math.PI / 2],
    [cx - width / 2 + radius, cy - height / 2 + radius, Math.PI],
    [cx + width / 2 - radius, cy - height / 2 + radius, Math.PI * 1.5],
  ];
  for (const [cornerX, cornerY, start] of corners) {
    for (let step = 0; step <= segments; step++) {
      const angle = start + Math.PI / 2 * step / segments;
      points.push([round(cornerX + radius * Math.cos(angle)), round(cornerY + radius * Math.sin(angle))]);
    }
  }
  return points;
}

function isFinderCell(row, column, modules) {
  return (row < 7 && column < 7)
    || (row < 7 && column >= modules - 7)
    || (row >= modules - 7 && column < 7);
}

function finderCenterOutline(style, centerX, centerY, pitch) {
  if (style === 'circle') return circleOutline(centerX, centerY, 1.5 * pitch, 40);
  if (style === 'rounded') return roundedRectangleOutline(centerX, centerY, 3 * pitch, 3 * pitch, pitch * .7, 8);
  if (style === 'diamond') {
    const radius = 1.65 * pitch;
    return [[centerX, centerY + radius], [centerX - radius, centerY],
      [centerX, centerY - radius], [centerX + radius, centerY]]
      .map(point => point.map(value => round(value)));
  }
  return rectangleOutline(centerX, centerY, 3 * pitch, 3 * pitch);
}

function finderOutlines(style, centerStyle, left, bottom, pitch) {
  const outlines = [];
  const centerX = left + 3.5 * pitch;
  const centerY = bottom + 3.5 * pitch;
  if (style === 'circle') {
    for (let step = 0; step < 32; step++) {
      const a = Math.PI * 2 * step / 32;
      const b = Math.PI * 2 * (step + 1) / 32;
      outlines.push([
        [centerX + 3.5 * pitch * Math.cos(a), centerY + 3.5 * pitch * Math.sin(a)],
        [centerX + 3.5 * pitch * Math.cos(b), centerY + 3.5 * pitch * Math.sin(b)],
        [centerX + 2.5 * pitch * Math.cos(b), centerY + 2.5 * pitch * Math.sin(b)],
        [centerX + 2.5 * pitch * Math.cos(a), centerY + 2.5 * pitch * Math.sin(a)],
      ].map(point => point.map(value => round(value))));
    }
    outlines.push(finderCenterOutline(centerStyle, centerX, centerY, pitch));
    return outlines;
  }
  if (style === 'rounded') {
    const stroke = pitch;
    const radius = pitch * .5;
    outlines.push(roundedRectangleOutline(centerX, bottom + 6.5 * pitch, 7 * pitch, stroke, radius));
    outlines.push(roundedRectangleOutline(centerX, bottom + .5 * pitch, 7 * pitch, stroke, radius));
    outlines.push(roundedRectangleOutline(left + .5 * pitch, centerY, stroke, 5.2 * pitch, radius));
    outlines.push(roundedRectangleOutline(left + 6.5 * pitch, centerY, stroke, 5.2 * pitch, radius));
    outlines.push(finderCenterOutline(centerStyle, centerX, centerY, pitch));
    return outlines;
  }
  outlines.push(rectangleOutline(centerX, bottom + 6.5 * pitch, 7 * pitch, pitch));
  outlines.push(rectangleOutline(centerX, bottom + .5 * pitch, 7 * pitch, pitch));
  outlines.push(rectangleOutline(left + .5 * pitch, centerY, pitch, 5 * pitch));
  outlines.push(rectangleOutline(left + 6.5 * pitch, centerY, pitch, 5 * pitch));
  outlines.push(finderCenterOutline(centerStyle, centerX, centerY, pitch));
  return outlines;
}

function styledModuleOutline(style, centerX, centerY, pitch) {
  if (style === 'dots') return circleOutline(centerX, centerY, pitch * .48, 24);
  if (style === 'faceted') {
    const radius = pitch * .49;
    const cut = pitch * .16;
    return [[centerX + radius - cut, centerY + radius], [centerX - radius + cut, centerY + radius],
      [centerX - radius, centerY + radius - cut], [centerX - radius, centerY - radius + cut],
      [centerX - radius + cut, centerY - radius], [centerX + radius - cut, centerY - radius],
      [centerX + radius, centerY - radius + cut], [centerX + radius, centerY + radius - cut]]
      .map(point => point.map(value => round(value)));
  }
  if (style === 'rounded') {
    return roundedRectangleOutline(centerX, centerY, pitch * .96, pitch * .96, pitch * .22, 4);
  }
  return rectangleOutline(centerX, centerY, pitch, pitch);
}

function triangleModuleOutline(row, column, centerX, centerY, pitch, featureCell) {
  const neighborDirections = {
    up: [-1, 0], right: [0, 1], down: [1, 0], left: [0, -1],
  };
  const neighbors = new Set(Object.entries(neighborDirections)
    .filter(([, [rowDelta, columnDelta]]) => featureCell(row + rowDelta, column + columnDelta))
    .map(([name]) => name));
  const rotate = (sourcePoints, quarterTurns) => sourcePoints.map(([sourceX, sourceY]) => {
    let x = sourceX;
    let y = sourceY;
    for (let turn = 0; turn < quarterTurns % 4; turn++) [x, y] = [-y, x];
    return [x, y];
  });

  let points;
  if (neighbors.size === 0) {
    points = rotate([[-.46, -.48], [.5, 0], [-.46, .48]], Math.abs(row * 37 + column * 19) % 4);
  } else if (neighbors.size === 1) {
    const outwardTurn = { left: 0, down: 1, right: 2, up: 3 }[[...neighbors][0]];
    points = rotate([[-.5, -.5], [.2, -.5], [.5, 0], [.2, .5], [-.5, .5]], outwardTurn);
  } else if (neighbors.size === 2
    && !((neighbors.has('left') && neighbors.has('right'))
      || (neighbors.has('up') && neighbors.has('down')))) {
    const physical = { up: [0, 1], right: [1, 0], down: [0, -1], left: [-1, 0] };
    const [neighborX, neighborY] = [...neighbors].reduce(
      ([x, y], name) => [x + physical[name][0], y + physical[name][1]], [0, 0]);
    const cutCorner = [-neighborX * .5, -neighborY * .5];
    const square = [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]];
    const cornerIndex = square.findIndex(([x, y]) => x === cutCorner[0] && y === cutCorner[1]);
    const previous = square[(cornerIndex + 3) % 4];
    const corner = square[cornerIndex];
    const following = square[(cornerIndex + 1) % 4];
    const cut = .58;
    const before = [corner[0] + (previous[0] - corner[0]) * cut,
      corner[1] + (previous[1] - corner[1]) * cut];
    const after = [corner[0] + (following[0] - corner[0]) * cut,
      corner[1] + (following[1] - corner[1]) * cut];
    points = [...square.slice(0, cornerIndex), before, after, ...square.slice(cornerIndex + 1)];
  } else {
    points = [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]];
  }

  const signedArea = points.reduce((area, [x, y], index) => {
    const following = points[(index + 1) % points.length];
    return area + x * following[1] - following[0] * y;
  }, 0);
  if (signedArea < 0) points.reverse();
  return points.map(([x, y]) => [round(centerX + x * pitch), round(centerY + y * pitch)]);
}

function perimeterFrameOutlines(outline, width, height, inset, stroke) {
  const step = Math.max(1, Math.ceil(outline.length / 96));
  const sampled = outline.filter((_, index) => index % step === 0);
  const outer = insetOutline(sampled, width, height, inset);
  const inner = insetOutline(sampled, width, height, inset + stroke);
  return outer.map((point, index) => [
    point, outer[(index + 1) % outer.length], inner[(index + 1) % inner.length], inner[index],
  ]);
}

function featureOutlines(token) {
  if (token.feature_outlines) return token.feature_outlines;
  const outlines = [];
  const offset = token.modules * token.module_size / 2;
  const centerSpan = token.center_icon === 'none' ? 0 : token.center_span_modules;
  const centerStart = (token.modules - centerSpan) / 2;
  const centerEnd = centerStart + centerSpan;
  const styled = token.module_style !== 'square' || token.finder_style !== 'square'
    || token.finder_center_style !== 'square' || centerSpan;
  const featureCell = (row, column) => row >= 0 && row < token.modules && column >= 0
    && column < token.modules && token.matrix[row][column]
    && !isFinderCell(row, column, token.modules)
    && !(row >= centerStart && row < centerEnd && column >= centerStart && column < centerEnd);
  const moduleCenter = (row, column) => [
    (column + .5) * token.module_size - offset + token.qr_offset_x,
    offset - (row + .5) * token.module_size + token.qr_offset_y,
  ];
  if (styled) {
    if (token.module_style === 'triangle') {
      for (let row = 0; row < token.modules; row++) {
        for (let column = 0; column < token.modules; column++) {
          if (!featureCell(row, column)) continue;
          const [centerX, centerY] = moduleCenter(row, column);
          outlines.push(triangleModuleOutline(
            row, column, centerX, centerY, token.module_size, featureCell));
        }
      }
    } else if (token.module_style === 'lines') {
      for (let row = 0; row < token.modules; row++) {
        let column = 0;
        while (column < token.modules) {
          if (!featureCell(row, column)) {
            column++;
            continue;
          }
          const start = column;
          while (column < token.modules && featureCell(row, column)) column++;
          const run = column - start;
          const [centerX, centerY] = moduleCenter(row, start + (run - 1) / 2);
          outlines.push(run === 1
            ? circleOutline(centerX, centerY, token.module_size * .28, 20)
            : roundedRectangleOutline(centerX, centerY, token.module_size * (run - .08),
              token.module_size * .56, token.module_size * .28, 6));
        }
      }
    } else {
      for (let row = 0; row < token.modules; row++) {
        for (let column = 0; column < token.modules; column++) {
          if (!featureCell(row, column)) continue;
          const [centerX, centerY] = moduleCenter(row, column);
          outlines.push(styledModuleOutline(token.module_style, centerX, centerY, token.module_size));
        }
      }
    }
    const finderPositions = [
      [token.qr_offset_x - offset, token.qr_offset_y + offset - 7 * token.module_size],
      [token.qr_offset_x + offset - 7 * token.module_size, token.qr_offset_y + offset - 7 * token.module_size],
      [token.qr_offset_x - offset, token.qr_offset_y - offset],
    ];
    for (const [left, bottom] of finderPositions) {
      outlines.push(...finderOutlines(
        token.finder_style, token.finder_center_style, left, bottom, token.module_size));
    }
    if (!['none', 'blank'].includes(token.center_icon)) {
      outlines.push(...iconOutlines(token.center_icon, token.qr_offset_x, token.qr_offset_y, token.center_icon_size));
    }
    outlines.push(...(token.icon_outlines || iconOutlines(
      token.icon, token.icon_center_x, token.icon_center_y, token.icon_size)));
    if (token.outer_frame === 'outline') {
      const frameInset = (token.top_profile === 'straight' ? 0 : token.top_size) + .2;
      outlines.push(...perimeterFrameOutlines(
        token.outline, token.shape_width, token.shape_height, frameInset, token.outer_frame_width));
    }
    return outlines;
  }
  for (let row = 0; row < token.modules; row++) {
    let column = 0;
    while (column < token.modules) {
      if (!token.matrix[row][column]) {
        column++;
        continue;
      }
      const start = column;
      while (column < token.modules && token.matrix[row][column]) column++;
      const width = (column - start) * token.module_size;
      const height = token.module_size;
      const chamfer = 0.01;
      const x = start * token.module_size - offset + token.qr_offset_x;
      const y = offset - (row + 1) * token.module_size + token.qr_offset_y;
      outlines.push([
        [x + chamfer, y], [x + width - chamfer, y], [x + width, y + chamfer],
        [x + width, y + height - chamfer], [x + width - chamfer, y + height],
        [x + chamfer, y + height], [x, y + height - chamfer], [x, y + chamfer],
      ].map(point => point.map(value => round(value))));
    }
  }
  outlines.push(...(token.icon_outlines || iconOutlines(
    token.icon, token.icon_center_x, token.icon_center_y, token.icon_size)));
  if (token.outer_frame === 'outline') {
    const frameInset = (token.top_profile === 'straight' ? 0 : token.top_size) + .2;
    outlines.push(...perimeterFrameOutlines(
      token.outline, token.shape_width, token.shape_height, frameInset, token.outer_frame_width));
  }
  return outlines;
}

export function createToken(data, profile) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InputError('Expected token settings.');
  if (!profile) throw new InputError('The printer profile has not loaded yet.');
  const url = normalizeUrl(data.url || '');
  const nozzle = profile.nozzle;
  const preset = data.preset || 'custom';
  if (!TOKEN_PRESETS.has(preset)) throw new InputError('Token preset is not supported.');
  const shape = preset === 'business-card' ? 'rectangle' : (data.shape || 'circle');
  if (!TOKEN_SHAPES.has(shape)) throw new InputError('Token shape is not supported.');
  let cornerStyle = preset === 'business-card' ? 'custom' : (data.corner_style || 'default');
  if (!CORNER_STYLES.has(cornerStyle)) throw new InputError('Corner treatment is not supported.');
  if (shape === 'circle') cornerStyle = 'default';
  const edgeProfile = data.edge_profile || 'straight';
  if (!EDGE_PROFILES.has(edgeProfile)) throw new InputError('Edge treatment is not supported.');
  const edgeSize = number(data, 'edge_size', .8, .4, 2);
  const topProfile = data.top_profile || 'straight';
  if (!EDGE_PROFILES.has(topProfile)) throw new InputError('Top edge treatment is not supported.');
  const topSize = number(data, 'top_size', .8, .4, 2);
  const requestedDiameter = preset === 'business-card' ? 85.6 : number(data, 'diameter', 60, 25, 200);
  const requestedShapeHeight = preset === 'business-card' ? 54
    : (shape === 'rectangle' ? number(data, 'shape_height', Math.max(25, round(requestedDiameter * .72)), 25, 200) : requestedDiameter);
  let cornerRadius = measurementMm(data, 'corner_radius', preset === 'business-card' ? 3.2 : 4, .1, 100);
  if (shape === 'circle') cornerRadius = 0;
  else if (cornerStyle === 'custom' && cornerRadius > Math.min(requestedDiameter, requestedShapeHeight) / 2) {
    throw new InputError("Corner radius cannot exceed half the token's shortest side.");
  }
  const padding = measurementMm(data, 'padding', 1, 0, 25);
  const icon = data.icon || 'none';
  if (!TOKEN_ICONS.has(icon)) throw new InputError('Brand icon is not supported.');
  if (icon !== 'none' && preset !== 'business-card') {
    throw new InputError('Brand icons are available with the business-card preset.');
  }
  const moduleStyle = data.module_style || 'square';
  if (!QR_MODULE_STYLES.has(moduleStyle)) throw new InputError('QR module style is not supported.');
  const finderStyle = data.finder_style || 'square';
  if (!QR_FINDER_STYLES.has(finderStyle)) throw new InputError('QR finder style is not supported.');
  const finderCenterStyle = data.finder_center_style
    || (['rounded', 'circle'].includes(finderStyle) ? finderStyle : 'square');
  if (!QR_FINDER_CENTER_STYLES.has(finderCenterStyle)) throw new InputError('QR finder center style is not supported.');
  if ((finderCenterStyle === 'diamond' && finderStyle !== 'circle')
      || (finderStyle === 'circle' && finderCenterStyle === 'square')) {
    throw new InputError('This finder frame and center combination is not reliably scannable.');
  }
  const outerFrame = data.outer_frame || 'none';
  if (!QR_OUTER_FRAMES.has(outerFrame)) throw new InputError('QR outer frame style is not supported.');
  const centerIcon = data.center_icon || 'none';
  if (!QR_CENTER_ICONS.has(centerIcon)) throw new InputError('QR center icon is not supported.');
  if (centerIcon !== 'none' && (moduleStyle !== 'square' || finderStyle !== 'square' || finderCenterStyle !== 'square')) {
    throw new InputError('Center badges require classic blocks with square finder frames and centers for reliable sliced toolpaths.');
  }
  const maximumLayer = Math.min(0.3, nozzle * 0.75);
  const layerHeight = number(data, 'layer_height', 0.2, 0.08, maximumLayer);
  const firstLayer = number(data, 'first_layer', 0.2, 0.08, maximumLayer);
  const treatment = data.treatment || 'raised';
  if (!['raised', 'inset', 'flat'].includes(treatment)) throw new InputError('QR treatment must be raised, inset, or flat.');
  const construction = data.construction || 'single';
  if (!['single', 'two-piece'].includes(construction)) throw new InputError('Print construction is not supported.');
  if (construction === 'two-piece' && treatment !== 'inset') {
    throw new InputError('Two-piece construction is available only for inset tokens.');
  }
  const requestedBase = number(data, 'base', 1, 0.6, 8);
  const requestedRelief = number(data, 'relief', 1, 0.24, 2);
  const baseLayers = Math.max(1, Math.ceil((requestedBase - firstLayer) / layerHeight - 1e-8) + 1);
  const minimumTopLayers = treatment === 'inset' ? 5 : 2;
  const qrLayers = treatment === 'flat' ? baseLayers
    : Math.max(minimumTopLayers, Math.ceil(requestedRelief / layerHeight - 1e-8));
  const base = round(firstLayer + (baseLayers - 1) * layerHeight);
  const relief = treatment === 'flat' ? 0 : round(qrLayers * layerHeight);
  const warnings = [];
  if (Math.abs(base - requestedBase) > 1e-6
      || (treatment !== 'flat' && Math.abs(relief - requestedRelief) > 1e-6)) {
    const feature = treatment === 'inset' ? 'light top field' : 'QR';
    warnings.push(treatment === 'flat'
      ? `Thickness rounded up to complete layers: ${formatNumber(base)} mm.`
      : `Heights rounded up to complete layers: ${formatNumber(base)} mm base + ${formatNumber(relief)} mm ${feature}.`);
  }
  let correction = data.correction || 'M';
  if (!['M', 'Q', 'H'].includes(correction)) throw new InputError('Error correction must be M, Q, or H.');
  if (centerIcon !== 'none' && correction !== 'H') {
    correction = 'H';
    warnings.push('High error correction is required for a protected center badge.');
  } else if (moduleStyle === 'lines' && correction !== 'H') {
    correction = 'H';
    warnings.push('High error correction is required for line modules after slicing.');
  }
  let qr;
  try {
    qr = QRCode.create(url, { errorCorrectionLevel: correction });
  } catch {
    throw new InputError('This URL is too long for a QR code.');
  }
  const modules = qr.modules.size;
  const matrix = Array.from({ length: modules }, (_, row) =>
    Array.from({ length: modules }, (_, column) => Boolean(qr.modules.get(row, column))));
  const styleScale = { square: 1, rounded: .96, dots: .96, faceted: .96, triangle: .8, lines: .56 }[moduleStyle];
  const minimumModule = Math.max(0.6, nozzle * 2) / styleScale;
  const perimeterInset = topProfile === 'straight' ? 0 : topSize;
  const outerFrameWidth = outerFrame === 'outline' ? Math.max(.8, nozzle * 2) : 0;
  const layoutClearance = padding + (outerFrame === 'outline' ? outerFrameWidth + .4 : 0);
  let minimumDiameter;
  let minimumHeight;
  let diameter;
  let shapeHeight;
  let moduleSize;
  let qrOffsetX = 0;
  const qrOffsetY = 0;
  if (preset === 'business-card') {
    minimumDiameter = 85.6;
    minimumHeight = 54;
    diameter = requestedDiameter;
    shapeHeight = requestedShapeHeight;
  } else if (shape === 'rectangle') {
    const minimumSide = minimumShapeWidth(
      'rectangle', modules, minimumModule, cornerStyle, perimeterInset, layoutClearance, cornerRadius);
    minimumDiameter = minimumSide;
    minimumHeight = minimumSide;
    diameter = Math.max(requestedDiameter, minimumDiameter);
    shapeHeight = Math.max(requestedShapeHeight, minimumHeight);
    if (diameter > requestedDiameter) {
      warnings.push(`Width increased to ${formatNumber(minimumDiameter)} mm so every QR module is printable with a ${formatNumber(nozzle)} mm nozzle.`);
    }
    if (shapeHeight > requestedShapeHeight) {
      warnings.push(`Height increased to ${formatNumber(minimumHeight)} mm so the QR quiet zone remains printable.`);
    }
  } else {
    minimumDiameter = minimumShapeWidth(
      shape, modules, minimumModule, cornerStyle, perimeterInset, layoutClearance, cornerRadius);
    minimumHeight = round(outlineDimensions(
      shapeOutline(shape, minimumDiameter, minimumDiameter, cornerStyle, cornerRadius)).height);
    diameter = Math.max(requestedDiameter, minimumDiameter);
    shapeHeight = diameter;
    if (diameter > requestedDiameter) {
      warnings.push(`Width increased to ${formatNumber(minimumDiameter)} mm so every QR module is printable with a ${formatNumber(nozzle)} mm nozzle.`);
    }
  }
  if (minimumDiameter > 200 || minimumHeight > 200) {
    throw new InputError(`This URL needs a larger ${shape} token than the supported 200 mm limit. Shorten the URL.`);
  }
  const maximumWidth = profile.max_width || profile.max_diameter;
  const maximumHeight = profile.max_height || profile.max_diameter;
  if (diameter > maximumWidth || shapeHeight > maximumHeight) {
    throw new InputError(`This token is ${formatNumber(diameter)} × ${formatNumber(shapeHeight)} mm, but this bed allows ${formatNumber(maximumWidth)} × ${formatNumber(maximumHeight)} mm with prime-tower clearance.`);
  }
  const outline = shapeOutline(shape, diameter, shapeHeight, cornerStyle, cornerRadius);
  const dimensions = outlineDimensions(outline);
  const usableOutline = insetOutline(outline, dimensions.width, dimensions.height, perimeterInset);
  if (preset === 'business-card') {
    const margin = layoutClearance;
    moduleSize = (dimensions.height - 2 * (perimeterInset + margin)) / (modules + 8);
    const fieldHalf = (modules + 8) * moduleSize / 2;
    qrOffsetX = dimensions.width / 2 - perimeterInset - margin - fieldHalf;
    moduleSize = Math.min(
      moduleSize, moduleSizeForOutline(usableOutline, modules, qrOffsetX, 0, layoutClearance));
    if (moduleSize < minimumModule) {
      throw new InputError(`This URL is too dense for the business-card preset with a ${formatNumber(nozzle)} mm nozzle. Shorten the URL or use a custom rectangle.`);
    }
  } else {
    moduleSize = moduleSizeForOutline(usableOutline, modules, 0, 0, layoutClearance);
  }
  if (moduleSize < 1.2) warnings.push(`QR modules are ${moduleSize.toFixed(2)} mm wide. Print a scan test; 1.2 mm or larger is more forgiving.`);
  const baseColor = color(data, 'base_color', treatment === 'inset' ? '#181818' : '#F5F0E5');
  const qrColor = color(data, 'qr_color', treatment === 'inset' ? '#F5F0E5' : '#181818');
  const light = luminance(treatment === 'inset' ? qrColor : baseColor);
  const dark = luminance(treatment === 'inset' ? baseColor : qrColor);
  if (light <= dark || (light + 0.05) / (dark + 0.05) < 4.5) {
    throw new InputError(treatment === 'inset'
      ? 'Use a dark base and a light top field with stronger contrast.'
      : 'Use a light base and a dark QR with stronger contrast.');
  }
  const filaments = ['base_filament', 'qr_filament'].map((key, index) => {
    const slot = number(data, key, index + 1, 1, profile.filament_count);
    if (!Number.isInteger(slot)) throw new InputError('Filament numbers must be whole numbers.');
    return slot;
  });
  if (filaments[0] === filaments[1]) throw new InputError('Base and QR must use different project filaments.');
  let iconCenterX = 0;
  let iconCenterY = 0;
  let iconSize = 0;
  if (preset === 'business-card' && icon !== 'none') {
    const fieldHalf = (modules + 8) * moduleSize / 2;
    const panelLeft = -dimensions.width / 2 + perimeterInset + 3;
    const panelRight = qrOffsetX - fieldHalf - 3;
    const panelWidth = panelRight - panelLeft;
    iconSize = Math.min(18, panelWidth - 4, dimensions.height - 2 * (perimeterInset + 8));
    if (iconSize < 8) throw new InputError('The business-card layout does not have enough room for this icon.');
    iconCenterX = round((panelLeft + panelRight) / 2);
  }
  const centerSpanModules = centerIcon === 'none' ? 0 : Math.max(5, Math.floor(modules * .19) | 1);
  const centerIconSize = centerIcon === 'none' || centerIcon === 'blank'
    ? 0 : round(centerSpanModules * moduleSize * .62);
  const result = {
    url,
    preset,
    shape,
    outline,
    shape_width: dimensions.width,
    shape_height: dimensions.height,
    corner_style: cornerStyle,
    corner_radius: cornerRadius,
    padding,
    edge_profile: edgeProfile,
    edge_size: edgeSize,
    top_profile: topProfile,
    top_size: topSize,
    edge_slices: treatment === 'raised' || treatment === 'flat'
      ? combinedBaseSlices(edgeProfile, edgeSize, topProfile, topSize, base)
      : edgeSlices(edgeProfile, edgeSize, base),
    top_slices: treatment === 'flat' ? [] : topEdgeSlices(topProfile, topSize, relief),
    diameter,
    minimum_diameter: minimumDiameter,
    minimum_height: minimumHeight,
    base,
    relief,
    height: treatment === 'flat' ? base : round(base + relief),
    layer_height: layerHeight,
    first_layer: firstLayer,
    base_layers: baseLayers,
    qr_layers: qrLayers,
    change_layer: treatment === 'flat' || construction === 'two-piece' ? null : baseLayers + 1,
    change_z: treatment === 'flat' || construction === 'two-piece' ? null : round(base + layerHeight),
    modules,
    module_size: moduleSize,
    quiet_modules: 4,
    matrix,
    qr_offset_x: round(qrOffsetX),
    qr_offset_y: qrOffsetY,
    icon,
    icon_center_x: iconCenterX,
    icon_center_y: iconCenterY,
    icon_size: round(iconSize),
    icon_outlines: iconOutlines(icon, iconCenterX, iconCenterY, iconSize),
    module_style: moduleStyle,
    finder_style: finderStyle,
    finder_center_style: finderCenterStyle,
    outer_frame: outerFrame,
    outer_frame_width: outerFrameWidth,
    center_icon: centerIcon,
    center_span_modules: centerSpanModules,
    center_icon_size: centerIconSize,
    base_color: baseColor,
    qr_color: qrColor,
    base_filament: filaments[0],
    qr_filament: filaments[1],
    warnings,
    correction,
    treatment,
    construction,
    scan_verified: false,
  };
  result.feature_outlines = featureOutlines(result);
  return result;
}

function requiredEntry(archive, name, maximum = 4_000_000) {
  const value = archive[name];
  if (!value || value.length > maximum) throw new InputError('Choose a Bambu Studio project 3MF containing printer settings.');
  return value;
}

export function parseTemplate(bytes, name = 'Bambu project') {
  let archive;
  try {
    const required = new Set(['3D/3dmodel.model', 'Metadata/project_settings.config']);
    archive = unzipSync(bytes, { filter: file => required.has(file.name) && file.originalSize <= 4_000_000 });
  } catch {
    throw new InputError('Choose a valid Bambu Studio project 3MF.');
  }
  const modelText = strFromU8(requiredEntry(archive, '3D/3dmodel.model'));
  if (/<!DOCTYPE|<!ENTITY/i.test(modelText)) throw new InputError('XML entities are not supported in templates.');
  let settings;
  try {
    settings = JSON.parse(strFromU8(requiredEntry(archive, 'Metadata/project_settings.config')));
  } catch {
    throw new InputError('Choose a Bambu Studio project 3MF containing printer settings.');
  }
  const application = modelText.match(/<metadata\s+name=["']Application["']>([^<]+)<\/metadata>/i)?.[1] || '';
  const filamentSettings = settings.filament_settings_id;
  if (!application.startsWith('BambuStudio-') || !Array.isArray(filamentSettings) || filamentSettings.length < 2 || filamentSettings.length > 16) {
    throw new InputError('Save this template as a project in Bambu Studio with 2 to 16 filaments first.');
  }
  const nozzle = Number(settings.nozzle_diameter?.[0]);
  const points = settings.printable_area?.map(point => String(point).trim().split('x').map(Number));
  if (!Number.isFinite(nozzle) || nozzle < 0.2 || nozzle > 0.8 || !Array.isArray(points) || points.length < 4 || points.some(point => point.length !== 2 || point.some(value => !Number.isFinite(value)))) {
    throw new InputError('Template is missing a supported nozzle size or bed outline.');
  }
  const materialTypes = settings.filament_type || ['PLA'];
  if (materialTypes.some(type => type !== materialTypes[0])) throw new InputError('Use the same material type for all template filaments, such as PLA.');
  const template = { application, settings, nozzle, points, filament_count: filamentSettings.length };
  return { template, profile: profileInfo(template, name) };
}

export function bedGeometry(template) {
  const xs = template.points.map(point => point[0]);
  const ys = template.points.map(point => point[1]);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  const width = maximumX - minimumX;
  const depth = maximumY - minimumY;
  const center = [(minimumX + maximumX) / 2, (minimumY + maximumY) / 2];
  return {
    width,
    depth,
    center,
    points: template.points.map(([x, y]) => [round(x - center[0]), round(y - center[1])]),
    max_width: Math.max(0, width - 60),
    max_height: Math.max(0, depth - 60),
    max_diameter: Math.max(0, Math.min(width, depth) - 60),
  };
}

export function profileInfo(template, name = 'Bambu project') {
  const settings = template.settings;
  const geometry = bedGeometry(template);
  return {
    name,
    printer: settings.printer_model || 'Bambu Lab',
    printer_preset: settings.printer_settings_id || '',
    nozzle: template.nozzle,
    filaments: settings.filament_settings_id,
    filament_count: template.filament_count,
    bed: settings.curr_bed_type || '',
    bed_width: geometry.width,
    bed_depth: geometry.depth,
    bed_points: geometry.points,
    max_width: geometry.max_width,
    max_height: geometry.max_height,
    max_diameter: geometry.max_diameter,
    application: template.application,
  };
}

function makeSlicedSolid(module, token, slices, zOffset = 0) {
  const { Manifold, CrossSection } = module;
  const tokenSection = new CrossSection([token.outline]);
  const parts = [];
  const sections = [];
  for (let index = 0; index < slices.length - 1; index++) {
    const [bottomZ, bottomInset] = slices[index];
    const [topZ, topInset] = slices[index + 1];
    if (topZ <= bottomZ) continue;
    const bottomScale = [
      (token.shape_width - 2 * bottomInset) / token.shape_width,
      (token.shape_height - 2 * bottomInset) / token.shape_height,
    ];
    const topScale = [
      (token.shape_width - 2 * topInset) / token.shape_width,
      (token.shape_height - 2 * topInset) / token.shape_height,
    ];
    const section = tokenSection.scale(bottomScale);
    sections.push(section);
    parts.push(section.extrude(topZ - bottomZ, 0, 0, [topScale[0] / bottomScale[0], topScale[1] / bottomScale[1]])
      .translate([0, 0, zOffset + bottomZ]));
  }
  const solid = parts.length === 1 ? parts[0] : Manifold.union(parts);
  return { solid, parts, sections, tokenSection };
}

function previewMeshData(solid) {
  const raw = solid.getMesh();
  return {
    vertices: new Float32Array(raw.vertProperties),
    triangles: new Uint32Array(raw.triVerts),
    volume: solid.volume(),
    bounds: solid.boundingBox(),
  };
}

function deleteSlicedBuild(build, keepSolid = false) {
  if (!keepSolid) build.solid.delete();
  if (build.parts.length > 1) build.parts.forEach(part => part.delete());
  build.sections.forEach(section => section.delete());
  build.tokenSection.delete();
}

function translateMeshData(mesh, offset) {
  const vertices = new Float32Array(mesh.vertices);
  for (let index = 0; index < vertices.length; index += 3) {
    vertices[index] += offset[0];
    vertices[index + 1] += offset[1];
    vertices[index + 2] += offset[2];
  }
  return { ...mesh, vertices };
}

function combineMeshData(meshes) {
  const vertexLength = meshes.reduce((sum, mesh) => sum + mesh.vertices.length, 0);
  const triangleLength = meshes.reduce((sum, mesh) => sum + mesh.triangles.length, 0);
  const vertices = new Float32Array(vertexLength);
  const triangles = new Uint32Array(triangleLength);
  let vertexOffset = 0;
  let triangleOffset = 0;
  let vertexCount = 0;
  for (const mesh of meshes) {
    vertices.set(mesh.vertices, vertexOffset);
    for (let index = 0; index < mesh.triangles.length; index++) {
      triangles[triangleOffset + index] = mesh.triangles[index] + vertexCount;
    }
    vertexOffset += mesh.vertices.length;
    triangleOffset += mesh.triangles.length;
    vertexCount += mesh.vertices.length / 3;
  }
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertices.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], vertices[index + axis]);
      maximum[axis] = Math.max(maximum[axis], vertices[index + axis]);
    }
  }
  return {
    vertices,
    triangles,
    volume: meshes.reduce((sum, mesh) => sum + mesh.volume, 0),
    bounds: { min: minimum, max: maximum },
  };
}

export function buildMaterialMeshes(module, token) {
  if (token.treatment !== 'flat' && token.construction !== 'two-piece') {
    throw new Error('This token does not use independently modeled material parts.');
  }
  const { CrossSection } = module;
  const baseBuild = makeSlicedSolid(module, token, token.edge_slices);
  const featureSection = new CrossSection(featureOutlines(token), 'NonZero');
  const overlap = Math.min(0.02, token.first_layer / 4);
  let cutter;
  let firstSolid;
  let secondSolid;
  let topBuild;
  try {
    if (token.treatment === 'flat') {
      cutter = featureSection.extrude(token.base + 2 * overlap).translate([0, 0, -overlap]);
      firstSolid = baseBuild.solid.subtract(cutter);
      secondSolid = baseBuild.solid.intersect(cutter);
      return [
        { name: 'Background', filament: token.base_filament, mesh: previewMeshData(firstSolid) },
        { name: 'QR', filament: token.qr_filament, mesh: previewMeshData(secondSolid) },
      ];
    }
    topBuild = makeSlicedSolid(module, token, token.top_slices);
    cutter = featureSection.extrude(token.relief + 2 * overlap).translate([0, 0, -overlap]);
    secondSolid = topBuild.solid.subtract(cutter);
    return [
      { name: 'Dark base', filament: token.base_filament, mesh: previewMeshData(baseBuild.solid) },
      { name: 'Light QR cap', filament: token.qr_filament, mesh: previewMeshData(secondSolid) },
    ];
  } finally {
    firstSolid?.delete();
    secondSolid?.delete();
    cutter?.delete();
    if (topBuild) deleteSlicedBuild(topBuild);
    featureSection.delete();
    deleteSlicedBuild(baseBuild);
  }
}

export function buildMesh(module, token) {
  if (token.treatment === 'flat') {
    const baseBuild = makeSlicedSolid(module, token, token.edge_slices);
    try { return previewMeshData(baseBuild.solid); } finally { deleteSlicedBuild(baseBuild); }
  }
  if (token.construction === 'two-piece') {
    const parts = buildMaterialMeshes(module, token);
    const spacing = token.shape_width / 2 + 3;
    return combineMeshData([
      translateMeshData(parts[0].mesh, [-spacing, 0, 0]),
      translateMeshData(parts[1].mesh, [spacing, 0, 0]),
    ]);
  }
  const { CrossSection } = module;
  const baseBuild = makeSlicedSolid(module, token, token.edge_slices);
  const featureSection = new CrossSection(featureOutlines(token), 'NonZero');
  const overlap = Math.min(0.02, token.first_layer / 4);
  const featureSolid = featureSection.extrude(token.relief + overlap).translate([0, 0, token.base - overlap]);
  let topBuild;
  let relief = featureSolid;
  let solid;
  try {
    if (token.treatment === 'inset') {
      topBuild = makeSlicedSolid(module, token, token.top_slices, token.base);
      relief = topBuild.solid.subtract(featureSolid);
    }
    solid = baseBuild.solid.add(relief);
    const mesh = previewMeshData(solid);
    if (mesh.triangles.length === 0 || Math.abs(mesh.bounds.min[2]) > 1e-5
        || Math.abs(mesh.bounds.max[2] - token.height) > 1e-4) {
      throw new Error('Geometry failed its solid bounds check.');
    }
    return mesh;
  } finally {
    solid?.delete();
    if (relief !== featureSolid) relief.delete();
    featureSolid.delete();
    if (topBuild) deleteSlicedBuild(topBuild);
    featureSection.delete();
    deleteSlicedBuild(baseBuild);
  }
}

export function buildPreviewParts(module, token) {
  if (token.treatment === 'flat') {
    const parts = buildMaterialMeshes(module, token);
    return { base: parts[0].mesh, top: parts[1].mesh };
  }
  if (token.construction === 'two-piece') {
    const parts = buildMaterialMeshes(module, token);
    return { base: parts[0].mesh, top: parts[1].mesh };
  }
  const { CrossSection } = module;
  const baseBuild = makeSlicedSolid(module, token, token.edge_slices);
  const featureSection = new CrossSection(featureOutlines(token), 'NonZero');
  const overlap = Math.min(0.02, token.first_layer / 4);
  const featureSolid = featureSection.extrude(token.relief + overlap).translate([0, 0, token.base - overlap]);
  let topBuild;
  let topSolid = featureSolid;
  try {
    if (token.treatment === 'inset') {
      topBuild = makeSlicedSolid(module, token, token.top_slices, token.base);
      topSolid = topBuild.solid.subtract(featureSolid);
    }
    return { base: previewMeshData(baseBuild.solid), top: previewMeshData(topSolid) };
  } finally {
    topSolid.delete();
    if (featureSolid !== topSolid) featureSolid.delete();
    if (topBuild) deleteSlicedBuild(topBuild);
    featureSection.delete();
    deleteSlicedBuild(baseBuild);
  }
}

export function encodeBinaryStl(mesh) {
  const triangleCount = mesh.triangles.length / 3;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  const header = encoder.encode('QR Token Studio watertight solid');
  new Uint8Array(buffer, 0, header.length).set(header);
  view.setUint32(80, triangleCount, true);
  const position = index => [mesh.vertices[index * 3], mesh.vertices[index * 3 + 1], mesh.vertices[index * 3 + 2]];
  let offset = 84;
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const a = position(mesh.triangles[triangle * 3]);
    const b = position(mesh.triangles[triangle * 3 + 1]);
    const c = position(mesh.triangles[triangle * 3 + 2]);
    const u = b.map((value, index) => value - a[index]);
    const v = c.map((value, index) => value - a[index]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...normal) || 1;
    for (const value of normal.map(component => component / length)) { view.setFloat32(offset, value, true); offset += 4; }
    for (const point of [a, b, c]) for (const value of point) { view.setFloat32(offset, value, true); offset += 4; }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function preparedSettings(template, token) {
  const settings = structuredClone(template.settings);
  const count = template.filament_count;
  const colors = [...(settings.filament_colour || [])];
  while (colors.length < count) colors.push('#FFFFFF');
  colors.length = count;
  colors[token.base_filament - 1] = token.base_color;
  colors[token.qr_filament - 1] = token.qr_color;
  settings.filament_colour = colors;
  settings.default_filament_colour = [...colors];
  settings.filament_is_mixed = Array(count).fill('0');
  settings.filament_multi_colour = [...colors];
  settings.filament_map = Array(count).fill('1');
  settings.filament_map_2 = Array(count).fill('1');
  settings.filament_nozzle_map = Array(count).fill('1');
  settings.single_extruder_multi_material = '1';
  settings.layer_height = formatNumber(token.layer_height);
  settings.initial_layer_print_height = formatNumber(token.first_layer);
  settings.sparse_infill_density = '100%';
  settings.sparse_infill_pattern = 'zig-zag';
  settings.wall_loops = '2';
  settings.top_one_wall_type = 'not apply';
  settings.top_shell_layers = '4';
  settings.bottom_shell_layers = '3';
  settings.enable_support = '0';
  settings.spiral_mode = '0';
  settings.print_sequence = 'by layer';
  settings.brim_type = 'no_brim';
  settings.enable_prime_tower = '1';
  settings.wall_generator = 'arachne';
  settings.from = 'project';
  settings.name = 'project_settings';
  const blocks = Math.max(1, settings.nozzle_diameter?.length || 1);
  const expected = count * count * blocks;
  let matrix = Array.isArray(settings.flush_volumes_matrix) && settings.flush_volumes_matrix.length === expected
    ? settings.flush_volumes_matrix.map(String)
    : Array.from({ length: expected }, (_, index) => index % (count + 1) === 0 ? '0' : '600');
  for (let block = 0; block < blocks; block++) {
    for (const [from, to] of [[token.base_filament, token.qr_filament], [token.qr_filament, token.base_filament]]) {
      const index = block * count * count + (from - 1) * count + to - 1;
      matrix[index] = String(Math.max(280, Number(matrix[index]) || 0));
    }
  }
  settings.flush_volumes_matrix = matrix;
  settings.wipe_tower_x = ['18'];
  settings.wipe_tower_y = ['18'];
  return settings;
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function metadata(key, value) {
  return `<metadata key="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`;
}

function meshXml(mesh, objectId = 1) {
  let vertices = '';
  for (let index = 0; index < mesh.vertices.length; index += 3) {
    vertices += `<vertex x="${formatNumber(mesh.vertices[index], 9)}" y="${formatNumber(mesh.vertices[index + 1], 9)}" z="${formatNumber(mesh.vertices[index + 2], 9)}"/>`;
  }
  let triangles = '';
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    triangles += `<triangle v1="${mesh.triangles[index]}" v2="${mesh.triangles[index + 1]}" v3="${mesh.triangles[index + 2]}"/>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter"><resources><object id="${objectId}" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build/></model>`;
}

function formatNumber(value, significant = 12) {
  if (Number.isInteger(value)) return String(value);
  return Number(value).toPrecision(significant).replace(/(?:\.0+|(\.\d+?)0+)(e|$)/, '$1$2');
}

export async function tokenFilename(token) {
  const host = new URL(token.url).hostname.replace(/[^a-z0-9.-]/gi, '-').slice(0, 48) || 'token';
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token.url)));
  const suffix = [...hash.slice(0, 4)].map(value => value.toString(16).padStart(2, '0')).join('');
  const details = [token.preset === 'business-card' ? 'business-card' : token.shape];
  if (token.corner_style !== 'default') details.push(token.corner_style);
  if (token.edge_profile !== 'straight') details.push(token.edge_profile);
  if (token.top_profile !== 'straight') details.push(`top-${token.top_profile}`);
  if (token.icon !== 'none') details.push(token.icon);
  if (token.module_style !== 'square') details.push(token.module_style);
  if (token.finder_style !== 'square') details.push(`eyes-${token.finder_style}`);
  if (token.finder_center_style !== 'square') details.push(`eye-center-${token.finder_center_style}`);
  if (token.outer_frame !== 'none') details.push('outlined');
  if (token.center_icon !== 'none') details.push(`center-${token.center_icon}`);
  if (token.construction === 'two-piece') details.push('two-piece');
  details.push(token.treatment);
  return `qr-${details.join('-')}-${host}-${suffix}`;
}

export function encodeBambu3mf(template, profile, token, mesh, filename, pngBytes, materialParts = []) {
  if (token.shape_width > (profile.max_width || profile.max_diameter)
      || token.shape_height > (profile.max_height || profile.max_diameter)) {
    throw new InputError('Token is too large for this bed with prime-tower clearance.');
  }
  const [centerX, centerY] = bedGeometry(template).center;
  let projectParts = [{ name: 'Token', filament: token.base_filament, mesh }];
  if (token.treatment === 'flat') projectParts = materialParts;
  if (token.construction === 'two-piece') {
    if (materialParts.length !== 2) throw new InputError('Two-piece export is missing its printable parts.');
    const gap = 6;
    if (token.shape_width * 2 + gap <= (profile.max_width || profile.max_diameter)) {
      const spacing = token.shape_width / 2 + gap / 2;
      projectParts = [
        { ...materialParts[0], mesh: translateMeshData(materialParts[0].mesh, [-spacing, 0, 0]) },
        { ...materialParts[1], mesh: translateMeshData(materialParts[1].mesh, [spacing, 0, 0]) },
      ];
    } else if (token.shape_height * 2 + gap <= (profile.max_height || profile.max_diameter)) {
      const spacing = token.shape_height / 2 + gap / 2;
      projectParts = [
        { ...materialParts[0], mesh: translateMeshData(materialParts[0].mesh, [0, -spacing, 0]) },
        { ...materialParts[1], mesh: translateMeshData(materialParts[1].mesh, [0, spacing, 0]) },
      ];
    } else {
      throw new InputError('Both inset pieces do not fit on this plate with prime-tower clearance. Reduce the token size.');
    }
  }
  if (!projectParts.length) throw new InputError('The material parts were not generated.');
  const triangleCount = projectParts.reduce((sum, part) => sum + part.mesh.triangles.length / 3, 0);
  const settings = preparedSettings(template, token);
  const date = new Date().toISOString().slice(0, 10);
  const rootId = projectParts.length + 1;
  const components = projectParts.map((part, index) => `<component objectid="${index + 1}" p:path="/3D/Objects/object_${index + 1}.model" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('');
  const changeDescription = token.change_z == null ? 'Material assignments are stored on independent model parts.'
    : `Change before layer ${token.change_layer}, top Z ${formatNumber(token.change_z)} mm.`;
  const rootModel = `<?xml version="1.0" encoding="utf-8"?><model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" unit="millimeter" requiredextensions="p"><metadata name="Application">${xmlEscape(template.application)}</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><metadata name="Title">${xmlEscape(filename)}</metadata><metadata name="CreationDate">${date}</metadata><metadata name="Description">QR Token Studio ${token.shape} with ${token.module_style} QR modules, ${token.finder_style} finder frames, ${token.finder_center_style} finder centers, ${token.outer_frame} outer framing, ${token.corner_style} corners, ${formatNumber(token.padding)} mm border padding, ${token.edge_profile} lower edge, and ${token.top_profile} top edge. ${label(token.treatment)} QR treatment. ${changeDescription}</metadata><resources><object id="${rootId}" type="model"><components>${components}</components></object></resources><build><item objectid="${rootId}" printable="1" transform="1 0 0 0 1 0 0 0 1 ${formatNumber(centerX)} ${formatNumber(centerY)} 0"/></build></model>`;
  const partSettings = projectParts.map((part, index) => `<part id="${index + 1}" subtype="normal_part">${metadata('name', part.name)}${metadata('extruder', part.filament)}${metadata('matrix', '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1')}<mesh_stat face_count="${part.mesh.triangles.length / 3}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/></part>`).join('');
  const objectExtruder = projectParts.length === 1 ? metadata('extruder', projectParts[0].filament) : '';
  const modelSettings = `<?xml version="1.0" encoding="utf-8"?><config><object id="${rootId}">${metadata('name', filename)}${objectExtruder}<metadata face_count="${triangleCount}"/>${partSettings}</object><plate>${metadata('plater_id', 1)}${metadata('plater_name', 'QR Token')}${metadata('locked', 'false')}${metadata('filament_map_mode', 'Manual')}${metadata('gcode_file', '')}${metadata('thumbnail_file', 'Metadata/plate_1.png')}<model_instance>${metadata('object_id', rootId)}${metadata('instance_id', 0)}${metadata('identify_id', 1)}</model_instance></plate><assemble/></config>`;
  const changeLayer = token.change_z == null ? '' : `<layer top_z="${formatNumber(token.change_z)}" type="2" extruder="${token.qr_filament}" color="${token.qr_color}" extra="" gcode="tool_change"/>`;
  const events = `<?xml version="1.0" encoding="utf-8"?><custom_gcodes_per_layer><plate><plate_info id="1"/>${changeLayer}<mode value="MultiAsSingle"/></plate></custom_gcodes_per_layer>`;
  const relationships = targets => `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets.map((target, index) => `<Relationship Target="${target}" Id="rel-${index + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('')}</Relationships>`;
  const contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="config" ContentType="application/octet-stream"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="json" ContentType="application/json"/></Types>';
  const reportMesh = combineMeshData(projectParts.map(part => part.mesh));
  const report = { ...token, profile, mesh: { watertight: true, triangles: triangleCount, volume_mm3: round(reportMesh.volume, 3) }, parts: projectParts.map(part => ({ name: part.name, filament: part.filament, triangles: part.mesh.triangles.length / 3 })) };
  delete report.matrix;
  delete report.outline;
  delete report.feature_outlines;
  const entries = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships(['/3D/3dmodel.model'])),
    '3D/_rels/3dmodel.model.rels': strToU8(relationships(projectParts.map((part, index) => `/3D/Objects/object_${index + 1}.model`))),
    '3D/3dmodel.model': strToU8(rootModel),
    'Metadata/project_settings.config': strToU8(JSON.stringify(settings, null, 2)),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/custom_gcode_per_layer.xml': strToU8(events),
    'Metadata/plate_1.png': pngBytes,
    'Metadata/qr_token.json': strToU8(JSON.stringify(report, null, 2)),
  };
  projectParts.forEach((part, index) => { entries[`3D/Objects/object_${index + 1}.model`] = strToU8(meshXml(part.mesh, index + 1)); });
  return zipSync(entries, { level: 6 });
}

export function inspect3mf(bytes) {
  const archive = unzipSync(bytes);
  return {
    names: Object.keys(archive).sort(),
    events: strFromU8(requiredEntry(archive, 'Metadata/custom_gcode_per_layer.xml')),
    settings: JSON.parse(strFromU8(requiredEntry(archive, 'Metadata/project_settings.config'))),
    report: JSON.parse(strFromU8(requiredEntry(archive, 'Metadata/qr_token.json'))),
  };
}
