import sharp from "sharp";
import { readFile } from "node:fs/promises";

const source = (await readFile("media/agents.svg", "utf8"))
  .replace('fill="currentColor"', 'fill="#52D4FF"')
  .replaceAll("currentColor", "#F4F8FF");

const logo = await sharp(Buffer.from(source)).resize(208, 208).png().toBuffer();
const background = Buffer.from(`
  <svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
    <rect width="256" height="256" rx="56" fill="#14243A"/>
    <circle cx="128" cy="128" r="100" fill="#1B3452"/>
  </svg>
`);

await sharp(background)
  .composite([{ input: logo, left: 24, top: 24 }])
  .png()
  .toFile("media/agents-icon.png");
