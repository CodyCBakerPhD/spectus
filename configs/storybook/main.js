export default {
    stories: ["../../stories/**/*.stories.@(js|ts|mdx)"],
    addons: [],
    framework: {
        name: "@storybook/html-vite",
        options: {},
    },
    staticDirs: [{ from: "../../src/assets", to: "/assets" }],
};
