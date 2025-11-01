// Test ES Module import
import { DucklingClient } from '../dist/index.mjs';

console.log('✅ ES Module import successful');
console.log('✅ DucklingClient exported as ES Module');
console.log('✅ Available exports:', Object.keys(await import('../dist/index.mjs')));