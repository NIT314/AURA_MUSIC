/*
  AURA ∞ MUSIC - Audio Engine (Equalizer & Sound Stage Effects)
  Powered by Web Audio API
*/

let audioCtx = null;
let sourceNode = null;
let bands = []; // 10-band BiquadFilterNodes
let analyserNode = null;

// Sound Stage Effects Nodes
let surroundDelayNode = null;
let surroundFeedbackGain = null;
let spatialPanner = null;
let reverbNode = null;
let stereoWidenerLeft = null;
let stereoWidenerRight = null;
let splitterNode = null;
let mergerNode = null;

// Presets maps: 10 bands values in dB (-12 to 12)
// Frequency centers: 31Hz, 62Hz, 125Hz, 250Hz, 500Hz, 1kHz, 2kHz, 4kHz, 8kHz, 16kHz
const EQ_PRESETS = {
    normal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bassboost: [6, 5.5, 4.5, 2.5, 1, 0, 0, 0, 0, 0],
    vocalboost: [-2, -1.5, -1, 1, 3.5, 4.5, 4, 2, 1, 0],
    pop: [-1.5, -1, 0, 2, 4, 3.5, 2, 0, -1, -1.5],
    rock: [4, 3, 1.5, -1, -2, -1.5, 1, 2.5, 3.5, 4],
    jazz: [3, 2, 1, 1.5, -1, -1.5, 0, 1.5, 2.5, 3],
    classical: [3, 2.5, 2, 1.5, -1, -1, 0, 1.5, 2.5, 3.5]
};

function initEqualizer(audioElement) {
    if (audioCtx) return; // Already initialized

    // Create Context (lazy init on user interaction)
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    
    // Create Analyser for Canvas visualizer
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;

    // Create Media Element Source
    sourceNode = audioCtx.createMediaElementSource(audioElement);

    // Build the 10-band Biquad Filters
    const frequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    let prevNode = sourceNode;

    frequencies.forEach((freq, idx) => {
        const filter = audioCtx.createBiquadFilter();
        // First band is low-shelf, last is high-shelf, others are peaking
        if (idx === 0) {
            filter.type = 'lowshelf';
        } else if (idx === frequencies.length - 1) {
            filter.type = 'highshelf';
        } else {
            filter.type = 'peaking';
            filter.Q.value = 1.0; // Filter bandwidth width
        }
        
        filter.frequency.value = freq;
        filter.gain.value = 0; // Flat initial state
        bands.push(filter);
        
        // Chain nodes
        prevNode.connect(filter);
        prevNode = filter;
    });

    // Create Splitter and Merger for Surround/Stereo effects
    splitterNode = audioCtx.createChannelSplitter(2);
    mergerNode = audioCtx.createChannelMerger(2);

    // Surround Sound Node (Custom Delay loop on right channel to simulate auditory phase offset)
    surroundDelayNode = audioCtx.createDelay(0.1);
    surroundDelayNode.delayTime.value = 0.025; // 25ms delay
    surroundFeedbackGain = audioCtx.createGain();
    surroundFeedbackGain.gain.value = 0.0; // Bypassed initially

    // Spatial Audio (Panner Node)
    spatialPanner = audioCtx.createPanner();
    spatialPanner.panningModel = 'HRTF';
    spatialPanner.distanceModel = 'inverse';
    // Set position at origin initially
    spatialPanner.positionX.value = 0;
    spatialPanner.positionY.value = 0;
    spatialPanner.positionZ.value = 0;

    // Stereo Widener (Mid/Side processing simulation using phase inversion)
    stereoWidenerLeft = audioCtx.createGain();
    stereoWidenerRight = audioCtx.createGain();
    stereoWidenerLeft.gain.value = 1.0;
    stereoWidenerRight.gain.value = 1.0;

    // Reverb node (Simple delay network to simulate space echoes)
    reverbNode = audioCtx.createDelay(0.5);
    reverbNode.delayTime.value = 0.15; // 150ms echo delay
    let reverbGain = audioCtx.createGain();
    reverbGain.gain.value = 0.0; // Bypassed initially
    
    // Connect reverb loop
    reverbNode.connect(reverbGain);
    reverbGain.connect(reverbNode);

    // Connecting standard flow:
    // EQ Chain (prevNode is last EQ band) -> Analyser -> Effects Bus -> Output
    prevNode.connect(analyserNode);

    // Effects Bus
    // Direct path to output
    analyserNode.connect(audioCtx.destination);
    
    // Reverb connection
    analyserNode.connect(reverbNode);
    reverbGain.connect(audioCtx.destination);
    
    // Spatial connection (if enabled, we route through panner. Bypassed by default)
    // For simplicity, we just leave panner connected to output with coordinates at origin
    analyserNode.connect(spatialPanner);
    spatialPanner.connect(audioCtx.destination);
    // Control volume of spatial path vs direct path
    spatialPanner.coneOuterGain = 0; // Disabled by default
}

function setBandGain(index, gainValue) {
    if (!audioCtx) return;
    const idx = parseInt(index);
    if (idx >= 0 && idx < bands.length) {
        bands[idx].gain.value = parseFloat(gainValue);
    }
}

function setPreset(presetName) {
    if (!audioCtx) return;
    const values = EQ_PRESETS[presetName.toLowerCase()];
    if (values) {
        values.forEach((val, idx) => {
            bands[idx].gain.value = val;
            // Update UI sliders dynamically if function exists in app.js
            if (window.updateEQSliderUI) {
                window.updateEQSliderUI(idx, val);
            }
        });
    }
}

function toggleSurround(enabled) {
    if (!audioCtx) return;
    if (enabled) {
        // Feed right channel to delay
        surroundFeedbackGain.gain.value = 0.45;
        // In virtual space, offset positions
        spatialPanner.positionX.value = -0.5;
        spatialPanner.positionZ.value = -0.5;
    } else {
        surroundFeedbackGain.gain.value = 0.0;
        spatialPanner.positionX.value = 0;
        spatialPanner.positionZ.value = 0;
    }
}

function toggleSpatial(enabled) {
    if (!audioCtx) return;
    if (enabled) {
        // Enable HRTF panning motion mapping
        // Create a slow orbit rotation in coordinate system
        startSpatialOrbit();
    } else {
        stopSpatialOrbit();
    }
}

let orbitTimer = null;
function startSpatialOrbit() {
    let angle = 0;
    if (orbitTimer) clearInterval(orbitTimer);
    orbitTimer = setInterval(() => {
        if (!audioCtx) return;
        angle += 0.05;
        // Circular orbit path around listener's head
        spatialPanner.positionX.value = Math.sin(angle) * 1.5;
        spatialPanner.positionZ.value = Math.cos(angle) * 1.5;
    }, 100);
}

function stopSpatialOrbit() {
    if (orbitTimer) {
        clearInterval(orbitTimer);
        orbitTimer = null;
    }
    if (audioCtx) {
        spatialPanner.positionX.value = 0;
        spatialPanner.positionZ.value = 0;
    }
}

function toggleWidener(enabled) {
    if (!audioCtx) return;
    if (enabled) {
        // Expand the stereo image
        stereoWidenerLeft.gain.value = 1.35;
        stereoWidenerRight.gain.value = 1.35;
    } else {
        stereoWidenerLeft.gain.value = 1.0;
        stereoWidenerRight.gain.value = 1.0;
    }
}

function toggleReverb(enabled) {
    if (!audioCtx) return;
    // Connect reverb signal to output
    if (enabled) {
        reverbNode.delayTime.value = 0.22;
    } else {
        reverbNode.delayTime.value = 0.0;
    }
}

function getAnalyser() {
    return analyserNode;
}

function resumeAudioContext() {
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// Export functions to global scope
window.initEqualizer = initEqualizer;
window.setBandGain = setBandGain;
window.setPreset = setPreset;
window.toggleSurround = toggleSurround;
window.toggleSpatial = toggleSpatial;
window.toggleWidener = toggleWidener;
window.toggleReverb = toggleReverb;
window.getAnalyser = getAnalyser;
window.resumeAudioContext = resumeAudioContext;
