import { useId } from "react";

export const palette = ["Grey", "Brown", "Orange", "Yellow", "Green", "Blue", "Purple", "Pink", "Red"] as const;
export type Colour = typeof palette[number];
export type ColourRule = {id: string; column: number; value: string; colour: Colour};

export function ruleColour(rules: ColourRule[], row: string[], types: string[]) {
  return rules.find(rule => {
    const expected = rule.value.trim().toLowerCase();
    if (!expected) return false;
    const cell = (row[rule.column] || "").toLowerCase();
    const values = types[rule.column] === "multiSelect" ? cell.split(",") : [cell];
    return values.some(value => value.trim() === expected);
  })?.colour;
}

export function ColourRules({columns, rules, defaultColumn, choices, onChange}: {
  columns: string[]; rules: ColourRule[]; defaultColumn: number;
  choices: (column: number) => string[]; onChange: (rules: ColourRule[]) => void;
}) {
  const prefix = useId();
  const update = (id: string, change: Partial<ColourRule>) =>
    onChange(rules.map(rule => rule.id === id ? {...rule, ...change} : rule));
  return <section className="colour-rules" aria-label="Card colour rules">
    <strong>Card colours</strong>
    <p>Colour matching records in this view. The first matching rule wins.</p>
    {rules.map(rule => <div key={rule.id} className="colour-rule">
      <select aria-label="Rule property" value={rule.column} onChange={e => update(rule.id, {column: Number(e.target.value), value: ""})}>
        {columns.map((name, i) => <option key={i} value={i}>{name}</option>)}
      </select>
      <span>is</span>
      <input aria-label="Rule value" placeholder="Choose or type a value" list={prefix + rule.id} value={rule.value} onChange={e => update(rule.id, {value: e.target.value})}/>
      <datalist id={prefix + rule.id}>{choices(rule.column).map(value => <option key={value} value={value}/>)}</datalist>
      <select aria-label="Rule colour" data-colour={rule.colour} value={rule.colour} onChange={e => update(rule.id, {colour: e.target.value as Colour})}>
        {palette.map(colour => <option key={colour}>{colour}</option>)}
      </select>
      <button onClick={() => onChange(rules.filter(other => other.id !== rule.id))}>Remove rule</button>
    </div>)}
    <button onClick={() => onChange([...rules, {id: crypto.randomUUID(), column: defaultColumn, value: "", colour: "Blue"}])}>Add colour rule</button>
  </section>;
}
