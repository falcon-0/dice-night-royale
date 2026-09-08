const fs = require('node:fs');
const path = require('node:path');

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const backup = `${file}.bak`;
    try {
      const recovered = JSON.parse(fs.readFileSync(backup, 'utf8'));
      writeJsonFile(file, recovered);
      console.warn(`Recovered ${path.basename(file)} from its last good backup.`);
      return recovered;
    } catch (backupError) {
      if (error.code === 'ENOENT' && backupError.code === 'ENOENT') return fallback;
      if (backupError.code === 'ENOENT') throw error;
      throw new Error(`Could not read ${path.basename(file)} or its backup: ${error.message}`);
    }
  }
}

function writeJsonFile(file, value) {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${file}.bak`;
  fs.mkdirSync(directory, { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (fs.existsSync(file)) {
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, backup);
      } catch {
        // Never replace a known-good backup with a damaged primary file.
      }
    }
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { readJsonFile, writeJsonFile };
