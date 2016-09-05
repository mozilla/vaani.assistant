/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

(function () {

const watson = require('watson-developer-cloud');

exports.text_to_speech = (config) => { return {
    synthesize: (params, callback) => {
        if (!config._watsontts)
            config._watsontts = watson.text_to_speech(config);
        return config._watsontts.synthesize(params, callback);
    }
}};

})();
