// Generator for fixture 18 (full-model-large): ~200 tables / ~5,000 columns,
// plus one 200,000-character JSON line. Generated in memory by the tests;
// run `node test/gen-full-model-large.mjs out.tmdl` to write it to disk.
import { writeFileSync } from 'node:fs';

/**
 * @param {{tables?:number, columns?:number, measures?:number, jsonChars?:number}} [opt]
 */
export function generateLargeModel(opt = {}) {
  const tables = opt.tables ?? 200;
  const columns = opt.columns ?? 25;
  const measures = opt.measures ?? 5;
  const jsonChars = opt.jsonChars ?? 200000;
  const out = ['createOrReplace', '', '\tmodel Model', '\t\tculture: en-US', ''];
  for (let t = 0; t < tables; t++) {
    const tn = t % 3 === 0 ? `'Table ${t}'` : `Table_${t}`;
    if (t % 2 === 0) out.push(`\t\t/// Deskripsi tabel ${t}`);
    out.push(`\t\ttable ${tn}`, `\t\t\tlineageTag: t-${t}`, '');
    for (let c = 0; c < columns; c++) {
      if ((t + c) % 4 === 0) out.push(`\t\t\t/// Kolom ${c} milik tabel ${t}`);
      out.push(`\t\t\tcolumn 'Col ${c}'`, '\t\t\t\tdataType: string', `\t\t\t\tsourceColumn: Col ${c}`, '', '\t\t\t\tannotation SummarizationSetBy = Automatic', '');
    }
    for (let m = 0; m < measures; m++) {
      out.push(`\t\t\tmeasure 'Measure ${t}.${m}' = \`\`\``, '\t\t\t\t\tVAR x = 1', '\t\t\t\t\ttable Fake', '\t\t\t\t\tRETURN x', '\t\t\t\t```', '\t\t\t\tformatString: 0', '');
    }
    out.push(`\t\t\tpartition ${tn} = m`, '\t\t\t\tmode: import', '\t\t\t\tsource =', '\t\t\t\t\t\tlet', '\t\t\t\t\t\t    Source = 1', '\t\t\t\t\t\tin', '\t\t\t\t\t\t    Source', '');
  }
  out.push('\t\tcultureInfo en-US', '');
  const json = '{"Version":"4.1.0","Entities":{' + '"x":1,'.repeat(Math.ceil(jsonChars / 6)).slice(0, jsonChars) + '}}';
  out.push('\t\t\tlinguisticMetadata = ' + json, '\t\t\t\tcontentType: json', '');
  out.push('\t\tannotation PBI_ProTooling = ["TMDLView_Desktop"]', '');
  return out.join('\r\n');
}

if (process.argv[1] && process.argv[1].endsWith('gen-full-model-large.mjs') && process.argv[2]) {
  writeFileSync(process.argv[2], generateLargeModel());
}
