export interface ThemeIcon {
  readonly id: string;
}

export namespace ThemeIcon {
  export const iconIdExpression = '[a-zA-Z0-9-]+(?:~spin)?';
  const encodedIcon = new RegExp('^\\$\\((' + iconIdExpression + ')\\)$');

  export function fromString(value: string): ThemeIcon | undefined {
    const match = encodedIcon.exec(value);
    return match?.[0] === value ? { id: match[1] } : undefined;
  }

  export function asClassName(icon: ThemeIcon): string {
    const [name, modifier] = icon.id.split('~');
    const classes = 'codicon codicon-' + name;
    return modifier === 'spin' ? classes + ' codicon-modifier-spin' : classes;
  }
}
