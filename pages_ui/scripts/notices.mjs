import fs from "node:fs";
import path from "node:path";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const sections = [
  "Lumen Pages — third-party software notices",
  "BlockNote 0.56.0 is used without modifications. Its MPL-2.0 source is available at https://github.com/TypeCellOS/BlockNote/tree/v0.56.0 and in the corresponding @blocknote/core, @blocknote/react, and @blocknote/mantine 0.56.0 npm distributions. No proprietary Notion source is included.",
  "The following notices include runtime dependencies; tree shaking may omit portions of individual packages.",
];
if (fs.existsSync('public/third-party-notices.txt')) {
  sections.push(fs.readFileSync('public/third-party-notices.txt', 'utf8'));
}
for (const [location, info] of Object.entries(lock.packages)) {
  if (!location || info.dev || !fs.existsSync(location)) continue;
  const meta = JSON.parse(
    fs.readFileSync(path.join(location, "package.json"), "utf8"),
  );
  const licenses = fs
    .readdirSync(location)
    .filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  sections.push(
    `${meta.name} ${meta.version}\nLicense: ${meta.license || info.license || "See upstream source"}\nSource: https://www.npmjs.com/package/${meta.name}/v/${meta.version}`,
  );
  for (const name of licenses) {
    const file = path.join(location, name);
    if (fs.statSync(file).isFile())
      sections.push(fs.readFileSync(file, "utf8"));
  }
}
sections.push(
  "Inter font: SIL Open Font License 1.1. See inter-license.txt in this directory.",
);
for (const name of fs.readdirSync("public/fonts").filter(name => name.endsWith("-OFL.txt"))) {
  sections.push(name + "\n" + fs.readFileSync(path.join("public/fonts", name), "utf8"));
}
fs.mkdirSync("dist/assets", { recursive: true });
fs.writeFileSync(
  "dist/assets/third-party-notices.txt",
  sections.join("\n\n----------------------------------------\n\n"),
);
