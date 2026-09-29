// Retain a small declarative Tailwind theme surface without passing candidate
// stylesheets to the host compiler (which could load plugins or filesystem data).
export function themeTokens(css='') {
  const clean=css.replace(/\/\*[\s\S]*?\*\//g,'');
  if(/@theme\b/.test(clean.replace(/@theme\s*(inline|static)?\s*\{([^{}]*)\}/g,'')))throw new Error('Preview @theme supports flat custom-property blocks with optional inline or static only. Put keyframes outside @theme.');
  const blocks=[];
  for(const match of clean.matchAll(/@theme\s*(inline|static)?\s*\{([^{}]*)\}/g)){
    const declarations=[];
    for(const text of match[2].split(';').map(value=>value.trim()).filter(Boolean)){
      const property=text.match(/^(--[a-zA-Z][a-zA-Z0-9-]{0,100})\s*:\s*([\s\S]+)$/);
      if(!property)throw new Error('Preview @theme supports custom-property declarations only.');
      const value=property[2].trim();
      if(value.length>1000||/[{};@\\<>]/.test(value)||/\b(?:url|expression)\s*\(/i.test(value))throw new Error('Unsupported value in preview @theme token '+property[1]+'.');
      declarations.push(property[1]+': '+value+';');
    }
    if(declarations.length>250)throw new Error('Preview @theme has too many tokens.');
    blocks.push('@theme'+(match[1]?' '+match[1]:'')+' {\n'+declarations.join('\n')+'\n}');
  }
  if(blocks.length>20)throw new Error('Preview has too many @theme blocks.');
  return blocks.join('\n');
}
