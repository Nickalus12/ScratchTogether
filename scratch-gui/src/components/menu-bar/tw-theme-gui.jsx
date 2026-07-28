import classNames from 'classnames';
import PropTypes from 'prop-types';
import React from 'react';
import {FormattedMessage, defineMessages} from 'react-intl';
import {connect} from 'react-redux';

import check from './check.svg';
import dropdownCaret from './dropdown-caret.svg';
import {MenuItem, Submenu} from '../menu/menu.jsx';
import {GUI_DARK, GUI_LIGHT, GUI_SQUIGGLE, Theme} from '../../lib/themes/index.js';
import {openGuiThemeMenu, guiThemeMenuOpen, closeSettingsMenu} from '../../reducers/menus.js';
import {setTheme} from '../../reducers/theme.js';
import {persistTheme} from '../../lib/themes/themePersistance.js';
import squiggleIcon from './sq-theme-squiggle.svg';
import lightModeIcon from './tw-sun.svg';
import darkModeIcon from './tw-moon.svg';
import styles from './settings-menu.css';

const options = defineMessages({
    [GUI_SQUIGGLE]: {
        defaultMessage: 'Squiggle',
        description: 'Name of the default color scheme, which uses Squiggle\'s own colors.',
        id: 'sq.guiTheme.squiggle'
    },
    [GUI_DARK]: {
        defaultMessage: 'Dark',
        description: 'Name of the neutral dark color scheme.',
        id: 'sq.guiTheme.dark'
    },
    [GUI_LIGHT]: {
        defaultMessage: 'Light',
        description: 'Name of the light color scheme.',
        id: 'sq.guiTheme.light'
    }
});

const icons = {
    [GUI_SQUIGGLE]: squiggleIcon,
    [GUI_DARK]: darkModeIcon,
    [GUI_LIGHT]: lightModeIcon
};

const ThemeIcon = ({id}) => (
    <img
        src={icons[id]}
        draggable={false}
        width={24}
        height={24}
        alt=""
    />
);

ThemeIcon.propTypes = {
    id: PropTypes.string
};

const GuiThemeMenuItem = ({id, isSelected, onClick}) => (
    <MenuItem onClick={onClick}>
        <div className={styles.option}>
            <img
                className={classNames(styles.check, {[styles.selected]: isSelected})}
                width={15}
                height={12}
                src={check}
                draggable={false}
            />
            <ThemeIcon id={id} />
            <FormattedMessage {...options[id]} />
        </div>
    </MenuItem>
);

GuiThemeMenuItem.propTypes = {
    id: PropTypes.string,
    isSelected: PropTypes.bool,
    onClick: PropTypes.func
};

const GuiThemeMenu = ({
    isOpen,
    isRtl,
    onChangeTheme,
    onOpenMenu,
    theme
}) => (
    <MenuItem expanded={isOpen}>
        <div
            className={styles.option}
            onClick={onOpenMenu}
        >
            <ThemeIcon id={theme.gui} />
            <span className={styles.submenuLabel}>
                <FormattedMessage
                    defaultMessage="Appearance"
                    description="Label for the menu that chooses the editor's color scheme"
                    id="sq.menuBar.appearance"
                />
            </span>
            <img
                className={styles.expandCaret}
                src={dropdownCaret}
                draggable={false}
            />
        </div>
        <Submenu place={isRtl ? 'left' : 'right'}>
            {Object.keys(options).map(id => (
                <GuiThemeMenuItem
                    key={id}
                    id={id}
                    isSelected={theme.gui === id}
                    // eslint-disable-next-line react/jsx-no-bind
                    onClick={() => onChangeTheme(theme.set('gui', id))}
                />
            ))}
        </Submenu>
    </MenuItem>
);

GuiThemeMenu.propTypes = {
    isOpen: PropTypes.bool,
    isRtl: PropTypes.bool,
    onChangeTheme: PropTypes.func,
    onOpenMenu: PropTypes.func,
    theme: PropTypes.instanceOf(Theme)
};

const mapStateToProps = state => ({
    isOpen: guiThemeMenuOpen(state),
    isRtl: state.locales.isRtl,
    theme: state.scratchGui.theme.theme
});

const mapDispatchToProps = dispatch => ({
    onChangeTheme: theme => {
        dispatch(setTheme(theme));
        dispatch(closeSettingsMenu());
        persistTheme(theme);
    },
    onOpenMenu: () => dispatch(openGuiThemeMenu())
});

export default connect(
    mapStateToProps,
    mapDispatchToProps
)(GuiThemeMenu);
