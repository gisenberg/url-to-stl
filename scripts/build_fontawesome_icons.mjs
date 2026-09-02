import {
  faFacebookF,
  faInstagram,
  faLinkedinIn,
  faTiktok,
  faXTwitter,
  faYoutube,
} from '@fortawesome/free-brands-svg-icons';
import { SVGPathData } from 'svg-pathdata';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'assets', 'fontawesome-brands.json');
const packageData = JSON.parse(await readFile(
  join(root, 'node_modules', '@fortawesome', 'free-brands-svg-icons', 'package.json'), 'utf8'));
const icons = {
  instagram: faInstagram,
  x: faXTwitter,
  facebook: faFacebookF,
  linkedin: faLinkedinIn,
  youtube: faYoutube,
  tiktok: faTiktok,
};

function pointOnCubic(start, command, t) {
  const inverse = 1 - t;
  return [
    inverse ** 3 * start[0] + 3 * inverse ** 2 * t * command.x1
      + 3 * inverse * t ** 2 * command.x2 + t ** 3 * command.x,
    inverse ** 3 * start[1] + 3 * inverse ** 2 * t * command.y1
      + 3 * inverse * t ** 2 * command.y2 + t ** 3 * command.y,
  ];
}

function flattenPath(path) {
  const commands = new SVGPathData(path).toAbs().normalizeHVZ().normalizeST().qtToC().aToC().commands;
  const outlines = [];
  let outline = [];
  let current = [0, 0];
  const finish = () => {
    if (outline.length > 2) outlines.push(outline);
    outline = [];
  };
  for (const command of commands) {
    if (command.type === SVGPathData.MOVE_TO) {
      finish();
      current = [command.x, command.y];
      outline.push(current);
    } else if (command.type === SVGPathData.LINE_TO) {
      current = [command.x, command.y];
      outline.push(current);
    } else if (command.type === SVGPathData.CURVE_TO) {
      const start = current;
      for (let step = 1; step <= 12; step++) outline.push(pointOnCubic(start, command, step / 12));
      current = [command.x, command.y];
    } else if (command.type === SVGPathData.CLOSE_PATH) {
      finish();
    } else {
      throw new Error(`Unsupported normalized SVG command ${command.type}.`);
    }
  }
  finish();
  return outlines;
}

function normalizeOutlines(outlines) {
  const points = outlines.flat();
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const minimumX = Math.min(...xs), maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys), maximumY = Math.max(...ys);
  const scale = 1 / Math.max(maximumX - minimumX, maximumY - minimumY);
  const centerX = (minimumX + maximumX) / 2;
  const centerY = (minimumY + maximumY) / 2;
  return outlines.map(outline => outline.map(([x, y]) => [
    Number(((x - centerX) * scale).toFixed(6)),
    Number(((centerY - y) * scale).toFixed(6)),
  ]));
}

const result = {
  source: '@fortawesome/free-brands-svg-icons',
  version: packageData.version,
  license: 'CC BY 4.0',
  attribution: 'Font Awesome Free by Fonticons, Inc. - https://fontawesome.com',
  icons: {},
};
for (const [name, definition] of Object.entries(icons)) {
  const [width, height, , , path] = definition.icon;
  if (typeof path !== 'string') throw new Error(`${definition.iconName} is not a single-path brand icon.`);
  result.icons[name] = {
    icon_name: definition.iconName,
    width,
    height,
    svg_path_data: path,
    outlines: normalizeOutlines(flattenPath(path)),
  };
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(`Built Font Awesome brand geometry at ${output}`);
