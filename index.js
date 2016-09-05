/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

(function(){

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const shortid = require('shortid');
const MemoryStream = require('memorystream');
const child_process = require('child_process');
const watson = require('watson-developer-cloud');
const stt = require('./lib/stt');
const tts = require('./lib/tts');
const Wakeword = require('./lib/wakeword');

const sorryUnderstand = 'Sorry, but I did not quite understand.';
const sorryTooLong = 'Sorry, but this was a bit too long for me.';
const sorryService = 'Sorry, the service is not available at the moment.';
const unknown = '<unknown>';

const OK = 0;
const ERROR_PARSING = 1;
const ERROR_EXECUTING = 2;
const ERROR_STT = 100;

const logdir = './log/';

if (!fs.existsSync(logdir)) {
    fs.mkdirSync(logdir);
}

const loadConfig = config => {

    const mergeObjects = (a, b) => {
        if (Array.isArray(a) && Array.isArray(b))
            return a.concat(b);
        else if (typeof(a) === 'object' && typeof(b) === 'object' && b) {
            for (var key in b) {
                if(b.hasOwnProperty(key)) {
                    if(a.hasOwnProperty(key))
                        a[key] = mergeObjects(a[key], b[key]);
                    else
                        a[key] = b[key];
                }
            }
            return a;
        } else
            return b || a;
    };

    const mergeConfigs = function () {
        var config = {};
        Array.prototype.slice.call(arguments, 0).forEach(file => {
            if (typeof(file) === 'string' && fs.existsSync(file)) {
                try {
                    file = JSON.parse(fs.readFileSync(file));
                } catch (ex) {
                    console.error('Problem reading configuration file: ' + file);
                }
            }
            if(typeof(file) === 'object' && file)
                config = mergeObjects(config, file);
        });
        return config;
    };

    return mergeConfigs({
        metric: (c, a, l, v) => console.log(`metric c: ${c} a: ${a} l: ${l} v: ${v}`),
        log: m => console.log(m),

        wakeword: "list maker",
        logaudios: 0,
        micgain: 0,
        vadaggressiveness: 0,
        kwscore: 0.80,
        kwsthreshold: 1e-40,
        VAD_BYTES:  640,
        MAX_LISTEN_TIME: 7500,
        MAX_SIL_TIME: 1500

    }, './config.json', './secret.json', config)
};

const run = config => {

    config = loadConfig(config);

    var streamvad,
        wakeTime,
        secsSilence,
        abort,
        wakeword,
        microphone,
        end_sound_played,
        lastvadStatus,
        dtStartSilence,
        totalSilencetime,
        logfile,
        rawlog,
        audio;

    const speech_to_text = stt.speech_to_text(config.stt);
    const text_to_speech = tts.text_to_speech(config.tts);

    const shelloutAsync = (command, params) =>
        child_process.spawn(command, params.split(' '));

    const shelloutSync = (command, params) =>
        child_process.spawnSync(command, params.split(' '));

    const setup = () => {
        if (process.platform === "linux") {
            this.shelloutSync('amixer',  "-c 2 set PCM 100%");
            this.shelloutSync('amixer',  "-c 3 set PCM 100%");
        }
        Wakeword.deviceName = config.micdevicename;
        Wakeword.metric = (c, a, l, v) => config.metric(c, a, l, v);

        microphone = Wakeword.getMic();
        microphone.pause();
        if ((process.env.VAANI_BOOTS || 1) < 2)
            playaudio('resources/start.wav');
        microphone.resume();
    };

    const playaudio = path => {
        if (process.platform === "darwin") {
            shelloutSync('play', path);
        } else {
            shelloutSync('aplay', ['-D', this.config.spkdevicename, path].join(' '));
        }
    };

    const greeting = () => {
        end_sound_played = false;
        microphone.pause();
        playaudio('resources/hi.wav');
        microphone.resume();
        dtStartSilence = totalSilencetime = null;
    };

    const endsound = () => {
        microphone.pause();
        // for situations when the server has VAD and respond before the client VAD
        // detects silence, we need to prevent the client from playing the beep twice
        if (!end_sound_played) {
            playaudio('resources/end_spot.wav');
            end_sound_played = true;
        }
        microphone.resume();
    };

    const vad = data => {
        if (!data) {
            return this.config.MAX_SIL_TIME;
        }

        var vadStatus = Wakeword.decoder.processWebrtcVad(data);

        if (lastvadStatus === 1 && vadStatus === 0){
            dtStartSilence = Date.now();
        } else if (lastvadStatus === 0 && vadStatus === 0 && dtStartSilence){
            totalSilencetime = Date.now() - dtStartSilence;
        } else if (lastvadStatus === 0 && vadStatus === 1) {
            totalSilencetime = 0;
        }

        lastvadStatus = vadStatus;
        return totalSilencetime;
    };

    const playresponse = () => {
        microphone.pause();
        // we check if the file is empty. if is, we play the sorry message
        //if (fs.statSync('output.wav').size === 0)
            playaudio('resources/error.wav');
        //else
        //    playaudio('output.wav');
        microphone.resume();
        Wakeword.resume();
        config.metric("tts", "play", "ok", 1);
    };

    const playerror = () => {
        microphone.pause();
        playaudio('resources/sorry.wav');
        microphone.resume();
        config.metric("tts", "play", "error", -1);
    };

    // Convert a gain (in decibels) to an amplitude amplification factor. See:
    // http://www.sengpielaudio.com/calculator-FactorRatioLevelDecibel.htm
    const amplificationFactor = gain => {
        return Math.sqrt(Math.pow(10, gain/10));
    };

    //
    // Amplify data by the specified gain, modifying the buffer in place.
    //
    //  - data is a Node Buffer object that contains little-endian signed
    //    16-bit values.
    //  - factor is the desired amplification. The samples will be multiplied
    //    by this number.
    //
    const amplify = (data, factor) => {
        // View the bytes in the buffer as signed 16 bit values
        var samples = new Int16Array(data.buffer,
                                   data.byteOffset,
                                   data.byteLength / 2);

        // Now do the multiplication, clipping values rather than
        // wrapping around.
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            s = Math.round(s * factor);
            if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
            samples[i] = s;
        }
    };

    const writeToSinks = data => {
        audio.write(data);
        rawlog.write(data);
    };

    const closeSinks = () => {
        if (streamvad) { streamvad.end(); streamvad = null; }
        if (audio)     { audio.end();     audio = null; }
        if (rawlog)    { rawlog.end();    rawlog = null; }
    };

    const resetlisten = () => {
        closeSinks();
        Wakeword.resume();
        Wakeword.pause();
        abort = true;
    };

    const fail = (message) => {
        closeSinks();
        config.log('failed - ' + message);
    };

    const answer = (status, message, command, confidence) => {
        config.log('sending answer - ' + status + ' - ' + message);
        try {
            fs.writeFile(
                logfile + '.json',
                JSON.stringify({
                    status: status,
                    message: message,
                    command: command,
                    confidence: confidence || 1
                }),
                err => err && config.log("problem logging json - " + err)
            );

            var player = shelloutAsync('play', '-t wav -'),
                voice = text_to_speech.synthesize({
                    text: [
                        '<express-as type="',
                            (status > 0 ? 'Apology' : ''),
                        '">',
                        message,
                        '</express-as>'
                    ].join(''),
                    voice: 'en-US_AllisonVoice',
                    accept: 'audio/wav'
                }, err => err && fail('problem with TTS service - ' + err));
            voice.on('data', data => player.stdin.write(data));
            voice.on('end', () => player.stdin.end());
        } catch(ex) {
            fail('answering - ' + JSON.stringify(ex));
        }
    };

    const interpret = (command, confidence) => {
        answer(OK, 'Santa says: ' + command, command, confidence);
    };

    const spotted = (data, word) => {

        console.log('SPOTTED!!!!!!!!!!!');

        let samples;

        if (!streamvad) {
            greeting();
            streamvad = new MemoryStream();
            wakeTime = Date.now();
            abort = false;

            logfile = path.join(logdir, shortid.generate());
            rawlog = fs.createWriteStream(logfile + '.raw');
            audio = new stream.PassThrough();
            rawlog.on('error', err => config.log('problem logging audio - ' + err));
            audio.on('error', err => config.log('problem passing audio - ' + err));
            speech_to_text.recognize({ audio: audio }, (err, res) => {
                if(err) {
                    config.log('problem STT - ' + err);
                    answer(ERROR_STT, sorryService, unknown, 0);
                } else
                    interpret(res.transcript, res.confidence);
                resetlisten();
                Wakeword.resume();
            });
        }

        streamvad.write(data);

        while ((samples = streamvad.read(config.VAD_BYTES))) {
            secsSilence = vad(samples);
            writeToSinks(samples);
            //servertools.streamToServer(samples);
        }

        if ((Date.now() - wakeTime > config.MAX_LISTEN_TIME) || (secsSilence >= config.MAX_SIL_TIME) || abort) {
            endsound();
            resetlisten();
            config.metric("userspeech", "end", "ok", 1);
        }
    };

    Wakeword.listen(
        [config.wakeword],
        config.kwscore,
        config.kwsthreshold,
        spotted,
        setup
    );
};

exports.loadConfig = loadConfig;
exports.run = run;

})();
