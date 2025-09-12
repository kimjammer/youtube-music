import sliderHTML from './templates/slider.html?raw';

import { getSongMenu } from '@/providers/dom-elements';
import { singleton } from '@/providers/decorators';

import { defaultTrustedTypePolicy } from '@/utils/trusted-types';

// Inline the phaze processor script to avoid import issues
const workerScript = `
// Simplified phaze-based pitch shifter processor
const WEBAUDIO_BLOCK_SIZE = 128;
const BUFFERED_BLOCK_SIZE = 4096;

function genHannWindow(length) {
    let win = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / length));
    }
    return win;
}

class OLAProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);

        this.nbInputs = options.numberOfInputs;
        this.nbOutputs = options.numberOfOutputs;

        this.blockSize = options.processorOptions.blockSize;
        this.hopSize = WEBAUDIO_BLOCK_SIZE;

        this.nbOverlaps = this.blockSize / this.hopSize;

        // pre-allocate input buffers
        this.inputBuffers = new Array(this.nbInputs);
        for (let i = 0; i < this.nbInputs; i++) {
            this.inputBuffers[i] = new Array(options.numberOfInputs);
            for (let j = 0; j < this.inputBuffers[i].length; j++) {
                this.inputBuffers[i][j] = new Float32Array(this.blockSize);
            }
        }

        this.outputBuffers = new Array(this.nbOutputs);
        for (let i = 0; i < this.nbOutputs; i++) {
            this.outputBuffers[i] = new Array(options.numberOfOutputs);
            for (let j = 0; j < this.outputBuffers[i].length; j++) {
                this.outputBuffers[i][j] = new Float32Array(this.blockSize);
            }
        }

        this.nbInputSamplesInBuffer = 0;
        this.nbOutputSamplesInBuffer = 0;
        this.inputBufferWriteIndex = 0;
        this.outputBufferReadIndex = 0;
    }

    process(inputs, outputs, parameters) {
        // buffer inputs until we have enough samples to process
        for (let i = 0; i < inputs.length; i++) {
            for (let j = 0; j < inputs[i].length; j++) {
                let input = inputs[i][j];
                for (let k = 0; k < input.length; k++) {
                    this.inputBuffers[i][j][this.inputBufferWriteIndex + k] = input[k];
                }
            }
        }

        this.inputBufferWriteIndex += WEBAUDIO_BLOCK_SIZE;
        this.nbInputSamplesInBuffer += WEBAUDIO_BLOCK_SIZE;

        if (this.inputBufferWriteIndex >= this.blockSize) {
            this.inputBufferWriteIndex = 0;
        }

        if (this.nbInputSamplesInBuffer >= this.blockSize) {
            this.processOLA(
                this.inputBuffers, this.outputBuffers, parameters);
            this.nbInputSamplesInBuffer -= this.hopSize;
            this.nbOutputSamplesInBuffer += this.blockSize;
        }

        // output what we have in the output buffer
        for (let i = 0; i < outputs.length; i++) {
            for (let j = 0; j < outputs[i].length; j++) {
                let output = outputs[i][j];
                for (let k = 0; k < output.length; k++) {
                    if (this.nbOutputSamplesInBuffer > 0) {
                        output[k] = this.outputBuffers[i][j][this.outputBufferReadIndex + k];
                    } else {
                        output[k] = 0;
                    }
                }
            }
        }

        this.outputBufferReadIndex += WEBAUDIO_BLOCK_SIZE;
        this.nbOutputSamplesInBuffer -= WEBAUDIO_BLOCK_SIZE;

        if (this.outputBufferReadIndex >= this.blockSize) {
            this.outputBufferReadIndex = 0;
        }

        return true;
    }

    processOLA(inputs, outputs, parameters) {
        // to be overridden
    }
}

class PhaseVocoderProcessor extends OLAProcessor {
    static get parameterDescriptors() {
        return [{
            name: 'pitchFactor',
            defaultValue: 1.0
        }];
    }

    constructor(options) {
        options.processorOptions = {
            blockSize: BUFFERED_BLOCK_SIZE,
        };
        super(options);

        this.fftSize = this.blockSize;
        this.timeCursor = 0;

        this.hannWindow = genHannWindow(this.blockSize);

        // Simple implementation using time domain pitch shifting
        this.pitchShiftBuffer = new Float32Array(this.blockSize * 2);
        this.pitchShiftIndex = 0;
    }

    processOLA(inputs, outputs, parameters) {
        // no automation, take last value
        const pitchFactor = parameters.pitchFactor[parameters.pitchFactor.length - 1];

        for (var i = 0; i < this.nbInputs; i++) {
            for (var j = 0; j < inputs[i].length; j++) {
                // Apply pitch shift using simple time domain approach
                var input = inputs[i][j];
                var output = outputs[i][j];

                this.applyHannWindow(input);
                this.applyPitchShift(input, output, pitchFactor);
                this.applyHannWindow(output);
            }
        }
    }

    applyHannWindow(buffer) {
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] *= this.hannWindow[i];
        }
    }

    applyPitchShift(input, output, pitchFactor) {
        // Simple time-domain pitch shifting
        for (let i = 0; i < output.length; i++) {
            const sourceIndex = i / pitchFactor;
            const index0 = Math.floor(sourceIndex);
            const index1 = index0 + 1;
            const fraction = sourceIndex - index0;

            if (index0 < input.length && index1 < input.length) {
                output[i] = input[index0] * (1 - fraction) + input[index1] * fraction;
            } else if (index0 < input.length) {
                output[i] = input[index0];
            } else {
                output[i] = 0;
            }
        }
    }
}

registerProcessor("phase-vocoder-processor", PhaseVocoderProcessor);
`;

import { ElementFromHtml } from '../utils/renderer';

const slider = ElementFromHtml(sliderHTML);

const roundToTwo = (n: number) => Math.round(n * 1e2) / 1e2;

const MIN_PITCH_SHIFT = -12;
const MAX_PITCH_SHIFT = 12;

let pitchShift = 0;

let storedAudioSource: AudioNode;
let storedAudioContext: AudioContext;
let pitchShifter: AudioWorkletNode;

const updatePitchShift = () => {
  const ONE_SEMITONE_LINEAR = Math.pow(2, 1 / 12);
  const linearPitch = Math.pow(ONE_SEMITONE_LINEAR, pitchShift);

  if (pitchShifter && pitchShifter.parameters.get('pitchFactor')) {
    pitchShifter.parameters.get('pitchFactor')!.setValueAtTime(linearPitch, storedAudioContext.currentTime);
  }

  const pitchShiftElement = document.querySelector('#pitch-shift-value');
  if (pitchShiftElement) {
    const targetHtml = String(pitchShift);
    (pitchShiftElement.innerHTML as string | TrustedHTML) =
      defaultTrustedTypePolicy
        ? defaultTrustedTypePolicy.createHTML(targetHtml)
        : targetHtml;
  }
};

let menu: Element | null = null;

const immediateValueChangedListener = (e: Event) => {
  pitchShift = (e as CustomEvent<{ value: number }>).detail.value;
  if (isNaN(pitchShift)) {
    pitchShift = 0;
  }

  updatePitchShift();
};

const setupSliderListener = singleton(() => {
  document
    .querySelector('#pitch-shift-slider')
    ?.addEventListener(
      'immediate-value-changed',
      immediateValueChangedListener,
    );
});

const observePopupContainer = () => {
  const observer = new MutationObserver(() => {
    if (!menu) {
      menu = getSongMenu();
    }

    if (menu && !menu.contains(slider)) {
      menu.prepend(slider);
      setupSliderListener();
    }
  });

  const popupContainer = document.querySelector('ytmusic-popup-container');
  if (popupContainer) {
    observer.observe(popupContainer, {
      childList: true,
      subtree: true,
    });
  }
};

const wheelEventListener = (e: WheelEvent) => {
  e.preventDefault();
  if (isNaN(pitchShift)) {
    pitchShift = 0;
  }

  // E.deltaY < 0 means wheel-up
  pitchShift = roundToTwo(
    e.deltaY < 0
      ? Math.min(pitchShift + 0.01, MAX_PITCH_SHIFT)
      : Math.max(pitchShift - 0.01, MIN_PITCH_SHIFT),
  );

  updatePitchShift();
  // Update slider position
  const pitchShiftSlider = document.querySelector<
    HTMLElement & { value: number }
  >('#pitch-shift-slider');
  if (pitchShiftSlider) {
    pitchShiftSlider.value = pitchShift;
  }
};

const setupWheelListener = () => {
  slider.addEventListener('wheel', wheelEventListener);
};

const removePitchShifter = () => {
  if (pitchShifter) {
    pitchShifter.disconnect();
    storedAudioSource.disconnect();
    storedAudioSource.connect(storedAudioContext.destination);
  }
};

const addPitchShifter = async () => {
  // Read audioWorker script as URI
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  const dataURI = await new Promise((res) => {
    reader.onloadend = function () {
      res(reader.result);
    };
  });
  if (typeof dataURI !== 'string') return;
  
  try {
    await storedAudioContext.audioWorklet.addModule(dataURI);
    pitchShifter = new AudioWorkletNode(storedAudioContext, 'phase-vocoder-processor');
    
    storedAudioSource.disconnect();
    storedAudioSource.connect(pitchShifter);
    pitchShifter.connect(storedAudioContext.destination);
  } catch (error) {
    console.error('Failed to add pitch shifter:', error);
  }
};

export const onPlayerApiReady = () => {
  observePopupContainer();
  setupWheelListener();

  if (!storedAudioSource || !storedAudioContext) {
    document.addEventListener(
      'ytmd:audio-can-play',
      ({ detail: { audioSource, audioContext } }) => {
        // Store audioSource and audioContext
        storedAudioSource = audioSource;
        storedAudioContext = audioContext;

        addPitchShifter();
      },
      { once: true, passive: true },
    );
  } else {
    addPitchShifter();
  }
};

export const onUnload = () => {
  slider.removeEventListener('wheel', wheelEventListener);
  getSongMenu()?.removeChild(slider);
  document
    .querySelector('#pitch-shift-slider')
    ?.removeEventListener(
      'immediate-value-changed',
      immediateValueChangedListener,
    );
  removePitchShifter();
};
