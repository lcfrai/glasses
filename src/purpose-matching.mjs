// Pure, bounded source-purpose hints shared with the byte-identical hosted copy.
// They adjust discovery ranking, never assert implementation/compatibility.
const text=value=>typeof value==='string'?value.normalize('NFKC').toLowerCase().slice(0,6000):'';
const spreadsheet=/\b(?:spreadsheets?|workbooks?|xlsx)\b|\b(?:google|online|collaborative)[ -]sheets?\b|\bmicrosoft excel\b|\bexcel[ -](?:files?|workbooks?|spreadsheets?|formulas?|documents?|tables?|imports?|exports?)\b/;
const threat=/\bthreat[ -]?model(?:s|ling|ing)?\b|\battack[ -](?:paths?|surfaces?|trees?)\b/;
const security=/\b(?:security|appsec|owasp|stride|sast|dast|pentest|vulnerabilit(?:y|ies)|penetration[ -]test(?:ing)?)\b/;

export function purposeAnchor(query){
 const raw=text(query).slice(0,500);if(/^https?:\/\//.test(raw.trim()))return null;
 // These are two explicit task families, not open-ended intent inference.
 const positive=raw.replace(/\b(?:without|excluding|except|not|no)\s+[^,;.!?]*/g,'');
 if(threat.test(positive))return 'threat-model';
 if(spreadsheet.test(positive)||/\bexcel\b/.test(positive))return 'spreadsheet';
 return null;
}

export function purposeEvidence(anchor,source={}){
 if(!anchor)return {level:'none',weight:1,bonus:0,matched:false};
 const primary=text(source.name)+'\n'+text(source.description),details=text(source.sourceDetails),tags=text(Array.isArray(source.tags)?source.tags.join(' '):source.tags);
 const direct=anchor==='spreadsheet'?spreadsheet:threat;
 if(direct.test(primary))return {level:'direct-source-purpose',weight:4,bonus:8,matched:true};
 if(direct.test(details))return {level:'documented-purpose',weight:2.5,bonus:6,matched:true};
 if(direct.test(tags)||(anchor==='threat-model'&&security.test(primary+'\n'+details+'\n'+tags)))return {level:'related-source-purpose',weight:1.5,bonus:4,matched:true};
 // Absence is uncertainty, not proof of incompatibility. Keep any existing
 // lexical match, with a penalty; never substitute inferred model labels here.
 return {level:'purpose-not-evidenced',weight:.1,bonus:0,matched:false};
}
