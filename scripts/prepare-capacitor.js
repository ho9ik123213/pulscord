const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const files = ['index.html', 'app-real.js', 'styles.css'];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const file of files) {
    fs.copyFileSync(path.join(root, file), path.join(output, file));
}

console.log(`Capacitor frontend prepared in ${path.relative(root, output)}`);
