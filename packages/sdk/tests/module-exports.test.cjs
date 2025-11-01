// Test CommonJS import
const { DucklingClient } = require('../dist/index.cjs');

console.log('✅ CommonJS import successful');
console.log('✅ DucklingClient exported in CommonJS');
console.log('✅ Available exports:', Object.keys(require('../dist/index.cjs')));