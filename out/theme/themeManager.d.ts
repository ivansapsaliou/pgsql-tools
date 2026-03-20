import * as vscode from 'vscode';
export interface ThemeColors {
    background: string;
    foreground: string;
    buttonBackground: string;
    buttonForeground: string;
    buttonHoverBackground: string;
    inputBackground: string;
    inputBorder: string;
    inputForeground: string;
    errorForeground: string;
    sideBarBackground: string;
    sideBarForeground: string;
    accentColor: string;
}
export declare class ThemeManager {
    private currentTheme;
    private themeColors;
    constructor();
    updateTheme(theme: vscode.ColorTheme): void;
    private getThemeColors;
    getColors(): ThemeColors;
    getThemeKind(): string;
    getCSSVariables(): string;
}
//# sourceMappingURL=themeManager.d.ts.map