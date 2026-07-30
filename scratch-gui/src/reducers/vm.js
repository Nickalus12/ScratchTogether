import VM from 'scratch-vm';
import storage from '../lib/storage';
import {MAXIMUM_CLOUD_VARIABLES} from '../lib/tw-cloud-limits';
import TogetherBlocks from '../lib/libraries/extensions/together';
import ThunderboltCooldowns from '../lib/libraries/extensions/cooldowns';
import ThunderboltHealthBars from '../lib/libraries/extensions/healthbars';
import ThunderboltText from '../lib/libraries/extensions/textengine';
import ThunderboltVFX from '../lib/libraries/extensions/vfx';
import ThunderboltSystem from '../lib/libraries/extensions/particles';

const SET_VM = 'scratch-gui/vm/SET_VM';
const defaultVM = new VM();
defaultVM.setCompatibilityMode(true);
defaultVM.runtime.cloudOptions.limit = MAXIMUM_CLOUD_VARIABLES;
defaultVM.attachStorage(storage);
// Builtin Together extension — main-thread access to SquiggleNet, saved
// by id (not URL) so projects work across LAN / tunnel / localhost hosts.
defaultVM.extensionManager.addBuiltinExtension('together', TogetherBlocks);
defaultVM.extensionManager.addBuiltinExtension('thunderboltcooldowns', ThunderboltCooldowns);
defaultVM.extensionManager.addBuiltinExtension('thunderbolthealthbars', ThunderboltHealthBars);
defaultVM.extensionManager.addBuiltinExtension('thunderbolttext', ThunderboltText);
defaultVM.extensionManager.addBuiltinExtension('thunderboltvfx', ThunderboltVFX);
defaultVM.extensionManager.addBuiltinExtension('thunderboltparticlesystem', ThunderboltSystem);
const initialState = defaultVM;

const reducer = function (state, action) {
    if (typeof state === 'undefined') state = initialState;
    switch (action.type) {
    case SET_VM:
        return action.vm;
    default:
        return state;
    }
};
const setVM = function (vm) {
    return {
        type: SET_VM,
        vm: vm
    };
};

export {
    reducer as default,
    initialState as vmInitialState,
    setVM
};
