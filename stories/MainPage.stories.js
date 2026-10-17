import rawHTML from "../src/index.html?raw";

export default {
    title: "Spectus/Main Page",
};

/**
 * Full page HTML derived from index.html via ?raw import so it always stays in sync with the source.  The page's
 * module does not run here, so no data is loaded and the plot containers remain empty, which is the intended state
 * for reviewing the controls and layout.
 *
 * Only the <body> content is extracted: the inline <head> script that adds the `preload` class to <html> never runs,
 * so the body stays visible without main.ts needing to remove it.
 */
const bodyMatch = rawHTML.match(/<body[^>]*>([\s\S]*)<\/body>/i);
const pageHTML = bodyMatch ? bodyMatch[1] : "";

export const DarkTheme = {
    render: () => {
        document.documentElement.setAttribute("data-theme", "dark");
        return pageHTML;
    },
};

export const LightTheme = {
    render: () => {
        document.documentElement.setAttribute("data-theme", "light");
        return pageHTML;
    },
};
