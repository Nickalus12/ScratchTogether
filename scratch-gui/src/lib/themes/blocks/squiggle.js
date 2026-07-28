import {hex2hsv, hsv2hex} from '../../tw-color-utils';

// Each category keeps its familiar Scratch hue on the outline and the label,
// but the fill is mixed toward the navy workspace instead of the neutral grey
// the upstream dark palette uses.
const SECONDARY = '#39406b';

const blockColors = {
    motion: {
        primary: '#152340',
        secondary: SECONDARY,
        tertiary: '#4C97FF',
        quaternary: '#4C97FF'
    },
    looks: {
        primary: '#221a44',
        secondary: SECONDARY,
        tertiary: '#9966FF',
        quaternary: '#9966FF'
    },
    sounds: {
        primary: '#2b1a3d',
        secondary: SECONDARY,
        tertiary: '#CF63CF',
        quaternary: '#CF63CF'
    },
    control: {
        primary: '#332a1c',
        secondary: SECONDARY,
        tertiary: '#FFAB19',
        quaternary: '#FFAB19'
    },
    event: {
        primary: '#332e16',
        secondary: SECONDARY,
        tertiary: '#FFBF00',
        quaternary: '#FFBF00'
    },
    sensing: {
        primary: '#16283a',
        secondary: SECONDARY,
        tertiary: '#5CB1D6',
        quaternary: '#5CB1D6'
    },
    pen: {
        primary: '#0c2b2e',
        secondary: SECONDARY,
        tertiary: '#0FBD8C',
        quaternary: '#0FBD8C'
    },
    operators: {
        primary: '#162a24',
        secondary: SECONDARY,
        tertiary: '#59C059',
        quaternary: '#59C059'
    },
    data: {
        primary: '#33251c',
        secondary: SECONDARY,
        tertiary: '#FF8C1A',
        quaternary: '#FF8C1A'
    },
    data_lists: {
        primary: '#331f1c',
        secondary: SECONDARY,
        tertiary: '#FF661A',
        quaternary: '#FF661A'
    },
    more: {
        primary: '#331d29',
        secondary: SECONDARY,
        tertiary: '#FF6680',
        quaternary: '#FF6680'
    },
    addons: {
        primary: '#0e3038',
        secondary: SECONDARY,
        tertiary: '#22d3ee',
        quaternary: '#22d3ee'
    },
    text: 'rgba(242, 244, 251, 0.85)',
    textFieldText: '#f2f4fb',
    textField: '#39406b',
    menuHover: 'rgba(255, 255, 255, 0.25)'
};

const extensions = {};

const customExtensionColors = {
    primary: primary => {
        const hsv = hex2hsv(primary);
        hsv[2] = Math.max(hsv[2] - 68, 20);
        return hsv2hex(hsv);
    },
    secondary: () => SECONDARY,
    tertiary: primary => primary,
    quaternary: primary => primary,
    categoryIconBackground: primary => customExtensionColors.primary(primary),
    categoryIconBorder: primary => customExtensionColors.tertiary(primary)
};

export {
    blockColors,
    extensions,
    customExtensionColors
};
