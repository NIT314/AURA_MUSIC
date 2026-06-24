/*
  AURA ∞ MUSIC - Audio Engine (Equalizer & Sound Stage Effects)
  Powered by Web Audio API
*/

let audioCtx = null;
let targetAudioElement = null;
let sourceNode = null;
let bands = []; // 10-band BiquadFilterNodes
let analyserNode = null;
let preAmpNode = null; // The secret Auto-Gain volume controller

// Sound Stage Effects Nodes
let surroundDelayNode = null;
let surroundFeedbackGain = null;
let spatialPanner = null;
let reverbNode = null;
let reverbGain = null;
let stereoWidenerLeft = null;
let stereoWidenerRight = null;
let splitterNode = null;
let mergerNode = null;

// Next-Level Audio Nodes


let bassEnhancerNode = null;   // Bass Enhancer
let lofiFilter = null;         // Lo-Fi effect
// convolverNode, normalizerNode — future use ke liye reserved

let masterGainNode = null;     // Final master volume

// Presets maps: Safe Bass Boost (Subtractive method to prevent clipping)
// Audio Modes — Complete sound signature presets
const AUDIO_MODES = {
    normal: {
        eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        reverb: false, surround: false, widener: false,
        bassEnhance: false, lofi: false,
        label: "Normal"
    },
    lofi: {
        eq: [2, 1.5, 0, -1, -2, -3, -4, -5, -6, -7],
        reverb: true, surround: false, widener: false,
        bassEnhance: true, lofi: true,
        label: "Lo-Fi"
    },
    concert: {
        eq: [1, 0.5, 0, 0.5, 1, 1.5, 1, 0.5, 1, 1.5],
        reverb: true, surround: true, widener: true,
        bassEnhance: false, lofi: false,
        label: "Live Concert"
    },
    night: {
        eq: [-2, -1, 0, 1, 2, 2.5, 2, 1, -1, -3],
        reverb: false, surround: false, widener: false,
        bassEnhance: false, lofi: false,
        label: "Night Mode"
    },
    podcast: {
        eq: [-3, -2, -1, 0, 2, 4, 4.5, 3, 1, -1],
        reverb: false, surround: false, widener: false,
        bassEnhance: false, lofi: false,
        label: "Podcast/Voice"
    },
    studio: {
        eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        reverb: false, surround: false, widener: false,
        bassEnhance: false, lofi: false,
        label: "Studio Monitor"
    }
};
const EQ_PRESETS = {
    normal: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bassboost: [3.5, 2.5, 1.5, 0, -1, -2, -2, -2, -2, -2], 
    vocalboost: [-2, -1.5, -1, 1, 3.5, 4.5, 4, 2, 1, 0],
    pop: [-1.5, -1, 0, 2, 4, 3.5, 2, 0, -1, -1.5],
    rock: [4, 3, 1.5, -1, -2, -1.5, 1, 2.5, 3.5, 4],
    jazz: [3, 2, 1, 1.5, -1, -1.5, 0, 1.5, 2.5, 3],
    classical: [3, 2.5, 2, 1.5, -1, -1, 0, 1.5, 2.5, 3.5]
};

function initEqualizer(audioElement) {
    if (audioCtx) return; // Already initialized
    targetAudioElement = audioElement;

    // Create Context
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    
    // Log AudioContext state changes for future debugging
    audioCtx.onstatechange = () => {
        console.log('AudioContext state changed:', audioCtx.state);
    };
    
    // Create Analyser for Canvas visualizer
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;

    // Create Media Element Source
    sourceNode = audioCtx.createMediaElementSource(audioElement);

    // SPOTIFY FIX: Dynamic Pre-Amp Node
    preAmpNode = audioCtx.createGain();
    preAmpNode.gain.value = 1.0; 
    sourceNode.connect(preAmpNode);

    // Build the 10-band Biquad Filters
    const frequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    let prevNode = preAmpNode;

    const sliders = document.querySelectorAll(".eq-slider");

    frequencies.forEach((freq, idx) => {
        const filter = audioCtx.createBiquadFilter();
        if (idx === 0) {
            filter.type = 'lowshelf';
        } else if (idx === frequencies.length - 1) {
            filter.type = 'highshelf';
        } else {
            filter.type = 'peaking';
            filter.Q.value = 1.0; // Filter bandwidth width
        }
        
        filter.frequency.value = freq;
        
        // Read slider value if available
        let initialGain = 0;
        const matchingSlider = Array.from(sliders).find(s => parseInt(s.getAttribute("data-index")) === idx);
        if (matchingSlider) {
            initialGain = parseFloat(matchingSlider.value) || 0;
        }
        filter.gain.value = initialGain;
        bands.push(filter);
        
        // Chain nodes
        prevNode.connect(filter);
        prevNode = filter;
    });

    // ⭐ AUTO-GAIN COMPENSATION ENGINE ⭐ initial trigger on startup
    let maxBoost = 0;
    bands.forEach(band => {
        if (band.gain.value > maxBoost) maxBoost = band.gain.value;
    });
    if (preAmpNode) {
        if (maxBoost > 0) {
            let safeGain = Math.pow(10, -(maxBoost * 0.85) / 20); 
            preAmpNode.gain.value = safeGain;
        } else {
            preAmpNode.gain.value = 1.0;
        }
    }

    // Create Splitter and Merger for Surround/Stereo effects
    splitterNode = audioCtx.createChannelSplitter(2);
    mergerNode = audioCtx.createChannelMerger(2);

    // Surround Sound Node
    surroundDelayNode = audioCtx.createDelay(0.1);
    surroundDelayNode.delayTime.value = 0.025; 
    surroundFeedbackGain = audioCtx.createGain();
    surroundFeedbackGain.gain.value = 0.0; 

    // Spatial Audio (Panner Node)
    spatialPanner = audioCtx.createPanner();
    spatialPanner.panningModel = 'HRTF';
    spatialPanner.distanceModel = 'inverse';
    spatialPanner.positionX.value = 0;
    spatialPanner.positionY.value = 0;
    spatialPanner.positionZ.value = 0;

    // Stereo Widener
    stereoWidenerLeft = audioCtx.createGain();
    stereoWidenerRight = audioCtx.createGain();
    stereoWidenerLeft.gain.value = 1.0;
    stereoWidenerRight.gain.value = 1.0;

    // Reverb node
    reverbNode = audioCtx.createDelay(0.5);
    reverbNode.delayTime.value = 0.0;
    reverbGain = audioCtx.createGain();
    reverbGain.gain.value = 0.0;

    // Bass Enhancer — sub-bass harmonics (punchy beats)
    bassEnhancerNode = audioCtx.createBiquadFilter();
    bassEnhancerNode.type = 'lowshelf';
    bassEnhancerNode.frequency.value = 80;
    bassEnhancerNode.gain.value = 0;

    // Lo-Fi Filter — muffled warm sound
    lofiFilter = audioCtx.createBiquadFilter();
    lofiFilter.type = 'lowpass';
    lofiFilter.frequency.value = 20000; // Default: fully open
    lofiFilter.Q.value = 0.7;
    lofiGain = audioCtx.createGain();
    lofiGain.gain.value = 1.0;

    // Master Gain — final volume control
    masterGainNode = audioCtx.createGain();
    masterGainNode.gain.value = 1.0;
    
    // Connect EQ output to splitter (stereo widener chain ke liye)
    prevNode.connect(splitterNode);

    // Stereo Widener: Left aur Right channels alag-alag process honge
    splitterNode.connect(stereoWidenerLeft, 0);
    splitterNode.connect(stereoWidenerRight, 1);

    // Dono channels merger mein aayenge
    stereoWidenerLeft.connect(mergerNode, 0, 0);
    stereoWidenerRight.connect(mergerNode, 0, 1);

    // Merger se analyser, phir spatialPanner
    mergerNode.connect(analyserNode);

    // Connect standard flow
    analyserNode.connect(spatialPanner);

    // Read initial UI effect toggles
    const surroundToggle = document.getElementById("effect-surround-toggle");
    const spatialToggle = document.getElementById("effect-spatial-toggle");
    const widenerToggle = document.getElementById("effect-widener-toggle");
    const reverbToggle = document.getElementById("effect-reverb-toggle");

    // Initialize Surround sound parameters based on UI
    if (surroundToggle && surroundToggle.checked) {
        surroundFeedbackGain.gain.value = 0.45;
        spatialPanner.positionX.value = 0;
        spatialPanner.positionZ.value = -0.5;
    }

    // Initialize Spatial Audio
    if (spatialToggle && spatialToggle.checked) {
        startSpatialOrbit();
    }

    // Initialize Stereo Widener
    if (widenerToggle && widenerToggle.checked) {
        stereoWidenerLeft.gain.value = 1.35;
        stereoWidenerRight.gain.value = 1.35;
    }

    // Initialize Reverb
    if (reverbToggle && reverbToggle.checked) {
        reverbNode.delayTime.value = 0.22;
        reverbGain.gain.value = 0.3;
    }

    // SOFT LIMITER: Prevents vocal pumping and distortion
    const masterLimiter = audioCtx.createDynamicsCompressor();
    masterLimiter.threshold.value = -1.0; 
    masterLimiter.knee.value = 0.0;
    masterLimiter.ratio.value = 20.0; 
    masterLimiter.attack.value = 0.005; 
    masterLimiter.release.value = 0.050;
    
    // Bass enhancer → lofi filter → masterLimiter (SIRF EK RASTA)
    spatialPanner.connect(bassEnhancerNode);
    bassEnhancerNode.connect(lofiFilter);
    lofiFilter.connect(masterLimiter);

    // NOTE: spatialPanner → masterLimiter direct connection HATAI — double audio fix

    // Surround delay chain
    spatialPanner.connect(surroundDelayNode);
    surroundDelayNode.connect(surroundFeedbackGain);
    surroundFeedbackGain.connect(masterLimiter);

    // Reverb chain
    spatialPanner.connect(reverbNode);
    reverbNode.connect(reverbGain);
    reverbGain.connect(masterLimiter);

    // Master gain → destination
    masterLimiter.connect(masterGainNode);
    masterGainNode.connect(audioCtx.destination);
    
    spatialPanner.coneOuterGain = 0;
}

function setBandGain(index, gainValue) {
    if (!audioCtx) return;
    const idx = parseInt(index);
    if (idx >= 0 && idx < bands.length) {
        bands[idx].gain.value = parseFloat(gainValue);
    }

    // ⭐ AUTO-GAIN COMPENSATION ENGINE ⭐
    let maxBoost = 0;
    bands.forEach(band => {
        if (band.gain.value > maxBoost) maxBoost = band.gain.value;
    });

    if (preAmpNode) {
        if (maxBoost > 0) {
            // Agar slider upar gaya hai, toh main volume apne aap safe ho jayega
            let safeGain = Math.pow(10, -(maxBoost * 0.85) / 20); 
            preAmpNode.gain.setTargetAtTime(safeGain, audioCtx.currentTime, 0.1);
        } else {
            // Normal volume
            preAmpNode.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.1);
        }
    }
    
    broadcastEQState();
}

function setPreset(presetName) {
    if (!audioCtx) return;
    const values = EQ_PRESETS[presetName.toLowerCase()];
    if (values) {
        const wasBlocked = blockEQBroadcast;
        blockEQBroadcast = true;
        try {
            values.forEach((val, idx) => {
                setBandGain(idx, val); // Using setBandGain to trigger Auto-Gain
                // Update UI sliders dynamically
                if (window.updateEQSliderUI) {
                    window.updateEQSliderUI(idx, val);
                }
            });
        } finally {
            blockEQBroadcast = wasBlocked;
        }
        broadcastEQState();
    }
}

function toggleSurround(enabled) {
    if (!audioCtx) return;
    if (enabled) {
        // Haas Effect: bahut chhota delay — brain ko lagega sound wrap ho rahi hai
        // Lekin koi ek side loud nahi hogi — perfectly balanced
        surroundDelayNode.delayTime.value = 0.018; // 18ms — surround sweet spot
        surroundFeedbackGain.gain.value = 0.3;     // Kam gain — balanced, no loudness shift

        // Panner center par rahega — koi side bias nahi
        spatialPanner.positionX.value = 0;
        spatialPanner.positionY.value = 0;
        spatialPanner.positionZ.value = -0.3; // Sirf thodi depth
        spatialPanner.refDistance = 1;
        spatialPanner.maxDistance = 10000;
        spatialPanner.rolloffFactor = 0;      // Distance se volume affect nahi hoga
    } else {
        surroundDelayNode.delayTime.value = 0.025;
        surroundFeedbackGain.gain.value = 0.0;
        spatialPanner.positionX.value = 0;
        spatialPanner.positionY.value = 0;
        spatialPanner.positionZ.value = 0;
        spatialPanner.rolloffFactor = 1;
    }
    broadcastEQState();
}

function toggleSpatial(enabled) {
    if (!audioCtx) return;
    if (enabled) {
        startSpatialOrbit();
    } else {
        stopSpatialOrbit();
    }
    broadcastEQState();
}

let orbitTimer = null;
function startSpatialOrbit() {
    let angle = 0;
    if (orbitTimer) clearInterval(orbitTimer);
    orbitTimer = setInterval(() => {
        if (!audioCtx) return;
        angle += 0.05;
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
        stereoWidenerLeft.gain.value = 1.35;
        stereoWidenerRight.gain.value = 1.35;
    } else {
        stereoWidenerLeft.gain.value = 1.0;
        stereoWidenerRight.gain.value = 1.0;
    }
    broadcastEQState();
}

function toggleReverb(enabled) {
    if (!audioCtx) return;
    if (enabled) {
        reverbNode.delayTime.value = 0.22;
        if (reverbGain) reverbGain.gain.value = 0.3;
    } else {
        reverbNode.delayTime.value = 0.0;
        if (reverbGain) reverbGain.gain.value = 0.0;
    }
    broadcastEQState();
}

function getAnalyser() {
    return analyserNode;
}

function resumeAudioContext() {
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}
// Bass Enhancer toggle
function toggleBassEnhancer(enabled) {
    if (!audioCtx || !bassEnhancerNode) return;
    if (enabled) {
        bassEnhancerNode.gain.value = 6.0; // +6dB sub-bass boost
    } else {
        bassEnhancerNode.gain.value = 0;
    }
    broadcastEQState();
}

// Lo-Fi Mode toggle
function toggleLofi(enabled) {
    if (!audioCtx || !lofiFilter) return;
    if (enabled) {
        // Muffled highs — classic lo-fi vinyl feel
        lofiFilter.frequency.setTargetAtTime(3500, audioCtx.currentTime, 0.1);
        lofiFilter.Q.value = 1.2;
    } else {
        // Fully open — normal sound
        lofiFilter.frequency.setTargetAtTime(20000, audioCtx.currentTime, 0.1);
        lofiFilter.Q.value = 0.7;
    }
    broadcastEQState();
}

// Master Volume control
function setMasterVolume(value) {
    if (!audioCtx || !masterGainNode) return;
    // value: 0.0 to 1.5
    masterGainNode.gain.setTargetAtTime(
        parseFloat(value), audioCtx.currentTime, 0.05
    );
}

// Audio Mode — ek click mein sab set ho jayega
function setAudioMode(modeName) {
    const mode = AUDIO_MODES[modeName.toLowerCase()];
    if (!mode || !audioCtx) return;

    const wasBlocked = blockEQBroadcast;
    blockEQBroadcast = true;
    try {
        // EQ set karo
        mode.eq.forEach((val, idx) => {
            setBandGain(idx, val);
            if (window.updateEQSliderUI) window.updateEQSliderUI(idx, val);
        });

        // Effects set karo
        toggleReverb(mode.reverb);
        toggleSurround(mode.surround);
        toggleWidener(mode.widener);
        toggleBassEnhancer(mode.bassEnhance);
        toggleLofi(mode.lofi);
    } finally {
        blockEQBroadcast = wasBlocked;
    }

    // UI toggles update karo
    const ids = {
        reverb: 'effect-reverb-toggle',
        surround: 'effect-surround-toggle',
        widener: 'effect-widener-toggle'
    };
    Object.entries(ids).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.checked = mode[key];
    });

    if (window.updateModeBtnUI) window.updateModeBtnUI(modeName);
    console.log(`Audio Mode: ${mode.label} activated`);
    
    broadcastEQState();
}

// Loudness Normalization — volume spikes smooth karo
function setLoudnessNormalization(enabled) {
    if (!audioCtx || !masterGainNode) return;
    if (enabled) {
        // Gentle limiting via master gain
        masterGainNode.gain.setTargetAtTime(0.85, audioCtx.currentTime, 0.1);
    } else {
        masterGainNode.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.1);
    }
}
let blockEQBroadcast = false;

function broadcastEQState() {
    if (blockEQBroadcast) return;
    if (window.isInsideJam && window.isInsideJam()) {
        const role = window.getJamRole ? window.getJamRole() : 'listener';
        if (role === 'host' || role === 'co-host') {
            const state = {
                bands: bands.map(b => b.gain.value),
                surround: document.getElementById("effect-surround-toggle")?.checked || false,
                spatial: document.getElementById("effect-spatial-toggle")?.checked || false,
                widener: document.getElementById("effect-widener-toggle")?.checked || false,
                reverb: document.getElementById("effect-reverb-toggle")?.checked || false,
                bassEnhance: bassEnhancerNode ? (bassEnhancerNode.gain.value > 0) : false,
                lofi: lofiFilter ? (lofiFilter.frequency.value < 10000) : false
            };
            if (window.sendJamEQState) {
                window.sendJamEQState(state);
            }
        }
    }
}

function applyHostEQState(settings) {
    if (!audioCtx) {
        const audioElement = document.getElementById("audio-element");
        if (audioElement) {
            initEqualizer(audioElement);
        }
    }
    if (!audioCtx) return;
    
    blockEQBroadcast = true;
    try {
        const badge = document.getElementById("jam-eq-synced-badge");
        if (badge) badge.classList.remove("hide");
        
        if (settings.bands && Array.isArray(settings.bands)) {
            settings.bands.forEach((val, idx) => {
                // Modify band without triggering a broadcast
                bands[idx].gain.value = parseFloat(val);
                if (window.updateEQSliderUI) window.updateEQSliderUI(idx, val);
            });
            // ⭐ AUTO-GAIN COMPENSATION ENGINE ⭐
            let maxBoost = 0;
            bands.forEach(band => {
                if (band.gain.value > maxBoost) maxBoost = band.gain.value;
            });
            if (preAmpNode) {
                if (maxBoost > 0) {
                    let safeGain = Math.pow(10, -(maxBoost * 0.85) / 20); 
                    preAmpNode.gain.setTargetAtTime(safeGain, audioCtx.currentTime, 0.1);
                } else {
                    preAmpNode.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.1);
                }
            }
        }
        if (settings.surround !== undefined) {
            // Modify surround without triggering broadcast
            if (settings.surround) {
                surroundDelayNode.delayTime.value = 0.018;
                surroundFeedbackGain.gain.value = 0.3;
                spatialPanner.positionX.value = 0;
                spatialPanner.positionY.value = 0;
                spatialPanner.positionZ.value = -0.3;
                spatialPanner.refDistance = 1;
                spatialPanner.maxDistance = 10000;
                spatialPanner.rolloffFactor = 0;
            } else {
                surroundDelayNode.delayTime.value = 0.025;
                surroundFeedbackGain.gain.value = 0.0;
                spatialPanner.positionX.value = 0;
                spatialPanner.positionY.value = 0;
                spatialPanner.positionZ.value = 0;
                spatialPanner.rolloffFactor = 1;
            }
            const surroundToggle = document.getElementById("effect-surround-toggle");
            if (surroundToggle) surroundToggle.checked = settings.surround;
        }
        if (settings.spatial !== undefined) {
            // Modify spatial without triggering broadcast
            if (settings.spatial) {
                startSpatialOrbit();
            } else {
                stopSpatialOrbit();
            }
            const spatialToggle = document.getElementById("effect-spatial-toggle");
            if (spatialToggle) spatialToggle.checked = settings.spatial;
        }
        if (settings.widener !== undefined) {
            // Modify widener without triggering broadcast
            if (settings.widener) {
                stereoWidenerLeft.gain.value = 1.35;
                stereoWidenerRight.gain.value = 1.35;
            } else {
                stereoWidenerLeft.gain.value = 1.0;
                stereoWidenerRight.gain.value = 1.0;
            }
            const widenerToggle = document.getElementById("effect-widener-toggle");
            if (widenerToggle) widenerToggle.checked = settings.widener;
        }
        if (settings.reverb !== undefined) {
            // Modify reverb without triggering broadcast
            if (settings.reverb) {
                reverbNode.delayTime.value = 0.22;
                if (reverbGain) reverbGain.gain.value = 0.3;
            } else {
                reverbNode.delayTime.value = 0.0;
                if (reverbGain) reverbGain.gain.value = 0.0;
            }
            const reverbToggle = document.getElementById("effect-reverb-toggle");
            if (reverbToggle) reverbToggle.checked = settings.reverb;
        }
        if (settings.bassEnhance !== undefined) {
            if (settings.bassEnhance) {
                bassEnhancerNode.gain.value = 6.0;
            } else {
                bassEnhancerNode.gain.value = 0;
            }
        }
        if (settings.lofi !== undefined) {
            if (settings.lofi) {
                lofiFilter.frequency.setTargetAtTime(3500, audioCtx.currentTime, 0.1);
                lofiFilter.Q.value = 1.2;
            } else {
                lofiFilter.frequency.setTargetAtTime(20000, audioCtx.currentTime, 0.1);
                lofiFilter.Q.value = 0.7;
            }
        }
    } finally {
        blockEQBroadcast = false;
    }
}

function clearHostEQSyncUI() {
    const badge = document.getElementById("jam-eq-synced-badge");
    if (badge) badge.classList.add("hide");
}

// Export functions to global scope
window.initEqualizer = initEqualizer;
window.setBandGain = setBandGain;
window.setPreset = setPreset;
window.toggleSurround = toggleSurround;
window.toggleSpatial = toggleSpatial;
window.toggleWidener = toggleWidener;
window.toggleReverb = toggleReverb;
window.toggleBassEnhancer = toggleBassEnhancer;
window.toggleLofi = toggleLofi;
window.setMasterVolume = setMasterVolume;
window.setAudioMode = setAudioMode;
window.setLoudnessNormalization = setLoudnessNormalization;
window.getAnalyser = getAnalyser;
window.resumeAudioContext = resumeAudioContext;
window.applyHostEQState = applyHostEQState;
window.clearHostEQSyncUI = clearHostEQSyncUI;

// Automatically resume AudioContext when returning to the foreground
document.addEventListener("visibilitychange", () => {
    if (!document.hidden && audioCtx && audioCtx.state === 'suspended' && targetAudioElement && !targetAudioElement.paused) {
        console.log("App returned to foreground, resuming suspended AudioContext...");
        audioCtx.resume();
    }
});