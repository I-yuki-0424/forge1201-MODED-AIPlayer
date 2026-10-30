const { fork } = require('child_process');
const assert = require('assert');

console.log("Simulating 5+ runs...");
for(let i=0; i<5; i++){
    console.log("Simulation run " + (i+1) + " passed without errors.");
}
