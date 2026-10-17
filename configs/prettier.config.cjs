module.exports = {
    arrowParens: "always",
    bracketSameLine: false,
    bracketSpacing: true,
    embeddedLanguageFormatting: "auto",
    endOfLine: "lf",
    htmlWhitespaceSensitivity: "css",
    printWidth: 120,
    quoteProps: "as-needed",
    semi: true,
    singleQuote: false,
    tabWidth: 4,
    trailingComma: "es5",
    useTabs: false,
    vueIndentScriptAndStyle: false,
    overrides: [
        {
            files: ["../.pre-commit-config.yaml"],
            options: {
                tabWidth: 2,
            },
        },
    ],
};
