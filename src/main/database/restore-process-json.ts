/** Fixed process-snapshot JSON only; no process query, path, command or restore
 * authority is supplied by this source. The query uses the same encoder that
 * native codec controls execute with synthetic scalar fixtures. */
export const WINDOWS_RESTORE_PROCESS_JSON_SOURCE = String.raw`
function Append-KnowBookProcessJsonString {
 param([Text.StringBuilder]$Output,[AllowNull()][object]$Value)
 if($null -eq $Value) { [void]$Output.Append('null'); return }
 if($Value -isnot [string]) { throw 'Invalid process string.' }
 $escaped=$Value.Replace('\','\\').Replace('"','\"')
 # Standard short escapes and bulk replacements keep previously readable
 # control-heavy data inside the same byte budget without per-character
 # PowerShell callbacks. Valid Unicode pairs remain compact UTF8.
 for($unit=0;$unit -lt 32;$unit++) {
  if($escaped.IndexOf([char]$unit) -lt 0) { continue }
  $replacement=switch($unit) {
   8 { '\b' }; 9 { '\t' }; 10 { '\n' }; 12 { '\f' }; 13 { '\r' }
   default { '\u'+$unit.ToString('x4',[Globalization.CultureInfo]::InvariantCulture) }
  }
  $escaped=$escaped.Replace([string][char]$unit,$replacement)
 }
 $escaped=$escaped.Replace([string][char]8232,'\u2028').Replace([string][char]8233,'\u2029')
 # Only isolated surrogate units need a callback before UTF8 stdout. This
 # preserves all UTF16 data without expanding valid astral characters.
 $escaped=[Text.RegularExpressions.Regex]::Replace($escaped,'[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]',[Text.RegularExpressions.MatchEvaluator]{
  param($character)
  '\u'+([int][char]$character.Value[0]).ToString('x4',[Globalization.CultureInfo]::InvariantCulture)
 })
 [void]$Output.Append('"')
 [void]$Output.Append($escaped)
 [void]$Output.Append('"')
}
function ConvertTo-KnowBookProcessJson {
 param([AllowNull()][AllowEmptyCollection()][object[]]$Rows)
 $encoded=[Text.StringBuilder]::new()
 [void]$encoded.Append('[')
 $firstRow=$true
 foreach($row in $Rows) {
  if($row['pid'] -isnot [int]) { throw 'Invalid process pid.' }
  if(-not $firstRow) { [void]$encoded.Append(',') }
  $firstRow=$false
  [void]$encoded.Append('{"pid":')
  [void]$encoded.Append($row['pid'].ToString([Globalization.CultureInfo]::InvariantCulture))
  foreach($field in @('name','executable','startToken')) {
   [void]$encoded.Append(',"')
   [void]$encoded.Append($field)
   [void]$encoded.Append('":')
   Append-KnowBookProcessJsonString -Output $encoded -Value $row[$field]
  }
  [void]$encoded.Append(',"argv":')
  $arguments=$row['argv']
  if($null -eq $arguments) { [void]$encoded.Append('null') }
  else {
   if($arguments -isnot [array]) { throw 'Invalid process argv.' }
   [void]$encoded.Append('[')
   $firstArgument=$true
   foreach($argument in $arguments) {
    if(-not $firstArgument) { [void]$encoded.Append(',') }
    $firstArgument=$false
    Append-KnowBookProcessJsonString -Output $encoded -Value $argument
   }
   [void]$encoded.Append(']')
  }
  [void]$encoded.Append('}')
  if($encoded.Length -gt (4*1024*1024)) { throw 'Process JSON exceeds the fixed output budget.' }
 }
 [void]$encoded.Append(']')
 $json=$encoded.ToString()
 $wireBytes=[Text.Encoding]::UTF8.GetByteCount($json)+[Text.Encoding]::UTF8.GetByteCount([Console]::Out.NewLine)
 if($wireBytes -gt (4*1024*1024)) { throw 'Process JSON exceeds the fixed output budget.' }
 return $json
}`
