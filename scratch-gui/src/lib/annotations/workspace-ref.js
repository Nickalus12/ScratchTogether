/* The outline panel lives in the menu bar and the workspace lives in the
 * blocks container, with no common ancestor that already holds it. Rather
 * than thread a ref through everything or read a window global, the blocks
 * container publishes it here. */

let workspace = null;

const setOutlineWorkspace = ws => {
    workspace = ws;
};

const getOutlineWorkspace = () => workspace;

/**
 * Scroll a comment to the middle of the viewport and flash it.
 * Mirrors Blockly's own centerOnBlock, which only handles blocks.
 * @param {string} id comment id
 * @returns {boolean} whether the comment was found
 */
const revealComment = id => {
    if (!workspace || !workspace.scrollbar) return false;
    const comment = workspace.getCommentById(id);
    if (!comment) return false;

    const xy = comment.getRelativeToSurfaceXY();
    const size = comment.getHeightWidth();
    const multiplier = workspace.RTL ? -1 : 1;
    const scale = workspace.scale;
    const metrics = workspace.getMetrics();

    const pixelX = (xy.x + (multiplier * size.width / 2)) * scale;
    const pixelY = (xy.y + (size.height / 2)) * scale;

    workspace.scrollbar.set(
        pixelX - metrics.contentLeft - (metrics.viewWidth / 2),
        pixelY - metrics.contentTop - (metrics.viewHeight / 2)
    );

    const root = comment.getSvgRoot();
    if (root) {
        root.classList.remove('sq-comment-flash');
        // Restart the animation even when the same entry is clicked twice.
        void root.getBoundingClientRect();
        root.classList.add('sq-comment-flash');
        setTimeout(() => root.classList.remove('sq-comment-flash'), 1200);
    }
    return true;
};

export {setOutlineWorkspace, getOutlineWorkspace, revealComment};
