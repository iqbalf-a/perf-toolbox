const fs = require('fs').promises;
const path = require('path');

const inputFileScenarioCode = path.join(__dirname, 'scenario_code.xml');
const inputFileListVuser = path.join(__dirname, 'list_vuser.txt');
const outputFile = path.join(__dirname, 'output_scenario_code.xml');

const patternBpVuser =
  /(<ScriptName>(BP[^_]+).*<\/ScriptName>\s+<VUsersNumber>)(\d+)/g;

async function main() {
  try {
    const data1 = await fs.readFile(inputFileListVuser, 'utf8');
    const vuserMap = {};
    const skippedLines = [];

    data1.replace(/\r/g, '').split('\n').forEach((item, i) => {
      if (!item.trim()) return;
      const parts = item.split('\t');
      if (parts.length < 2 || !parts[1].trim()) {
        skippedLines.push(`baris ${i + 1}: "${item.trim()}"`);
        return;
      }
      vuserMap[parts[0].trim()] = parts[1].trim();
    });

    if (skippedLines.length) {
      console.warn(`Baris tidak valid di list_vuser.txt:\n  ${skippedLines.join('\n  ')}`);
    }

    const notFound = [];
    const data2 = await fs.readFile(inputFileScenarioCode, 'utf8');
    let updated = 0;

    const outputText = data2.replace(
      patternBpVuser,
      (fullMatch, group1, bp, oldVuser) => {
        if (Object.hasOwn(vuserMap, bp)) {
          const newVuser = vuserMap[bp];
          console.log(`  ${bp}: ${oldVuser} -> ${newVuser}`);
          updated++;
          return group1 + newVuser;
        }
        notFound.push(bp);
        return fullMatch;
      }
    );

    await fs.writeFile(outputFile, outputText, 'utf8');

    console.log(`\nSelesai: ${updated} BP diupdate`);
    if (notFound.length) {
      console.warn(`BP tidak ditemukan di list_vuser.txt: ${[...new Set(notFound)].join(', ')}`);
    }
  } catch (err) {
    console.error('Terjadi kesalahan:', err);
  }
}

main();
