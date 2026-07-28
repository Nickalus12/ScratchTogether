// Squiggle's own dark theme. Same navy/violet tokens as the dashboard in
// collab-server/home.html, so the editor and the site read as one product.
// The menu bar gradient lives in accent/squiggle so picking another accent
// still gives a coherent bar.
const guiColors = {
    'color-scheme': 'dark',

    'ui-primary': '#10142a',
    'ui-secondary': '#161c36',
    'ui-tertiary': '#232b4d',

    'ui-modal-overlay': 'rgba(6, 8, 18, 0.72)',
    'ui-modal-background': '#131831',
    'ui-modal-foreground': '#f2f4fb',
    'ui-modal-header-background': '#1c2342',
    'ui-modal-header-foreground': '#ffffff',

    'ui-white': '#131831',
    'ui-white-dim': 'rgba(19, 24, 49, 0.75)',
    'ui-white-transparent': 'rgba(255, 255, 255, 0.14)',

    'ui-black-transparent': 'rgba(255, 255, 255, 0.11)',

    'text-primary': '#f2f4fb',
    'text-primary-transparent': 'rgba(242, 244, 251, 0.75)',

    'error-primary': '#fb7185',
    'error-light': '#fda4af',
    'error-transparent': 'rgba(251, 113, 133, 0.25)',

    'menu-bar-background': 'var(--looks-secondary)',

    'assets-background': '#10142a',

    'input-background': '#0d1020',

    'popover-background': '#161c36',

    'shadow': 'rgba(0, 0, 0, 0.55)',

    'badge-background': '#1c2347',
    'badge-border': '#3b3183',

    'fullscreen-background': '#0d1020',
    'fullscreen-accent': '#161c36',

    'page-background': '#0d1020',
    'page-foreground': '#f2f4fb',

    'project-title-inactive': 'rgba(255, 255, 255, 0.16)',
    'project-title-hover': 'rgba(255, 255, 255, 0.3)',

    'link-color': '#22d3ee',

    'filter-icon-black': 'invert(100%)',
    'filter-icon-gray': 'grayscale(100%) brightness(1.7)',
    'filter-icon-white': 'brightness(0) invert(100%)',

    'paint-filter-icon-gray': 'brightness(1.7)'
};

const blockColors = {
    insertionMarker: '#c7cce6',
    workspace: '#141a33',
    toolboxSelected: '#232b4d',
    toolboxText: '#c7cce6',
    toolbox: '#10142a',
    flyout: '#10142a',
    scrollbar: '#3a4370',
    valueReportBackground: '#161c36',
    valueReportBorder: '#2c3560',
    valueReportForeground: '#f2f4fb',
    contextMenuBackground: '#161c36',
    contextMenuBorder: 'rgba(255, 255, 255, 0.12)',
    contextMenuForeground: '#f2f4fb',
    contextMenuActiveBackground: '#252d52',
    contextMenuDisabledForeground: '#6d769a',
    flyoutLabelColor: '#c7cce6',
    checkboxInactiveBackground: '#1b2140',
    checkboxInactiveBorder: '#8f98bd',
    buttonBorder: '#8f98bd',
    buttonActiveBackground: '#232b4d',
    buttonForeground: '#dfe3f5',
    zoomIconFilter: 'invert(100%)',
    gridColor: '#242c4f'
};

export {
    guiColors,
    blockColors
};
