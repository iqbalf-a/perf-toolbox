const fs = require('fs').promises;
const inputFile = './raw_snapshot.c';
const outputFile = './output_snapshot.c';

const patternSnapshot = /(Snapshot=t)(\d+)/g;
let startIndex = 1;

async function main() {
  try {
    const inputText = await fs.readFile(inputFile, 'utf8');

    let index = startIndex;
    let updated = 0;
    const outputText = inputText.replace(
      patternSnapshot,
      (fullMatch, prefix, oldNum) => {
        const newNum = index++;
        console.log(`  Snapshot=t${oldNum} -> Snapshot=t${newNum}`);
        updated++;
        return prefix + newNum;
      }
    );

    await fs.writeFile(outputFile, outputText, 'utf8');
    console.log(`\nSelesai: ${updated} snapshot di-reindex`);
  } catch (err) {
    console.error('Terjadi kesalahan:', err);
  }
}

main();
