param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KnowbookTestShortPath {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern uint GetShortPathName(string path, StringBuilder result, uint size);
}
'@
$buffer = New-Object System.Text.StringBuilder 32768
$length = [KnowbookTestShortPath]::GetShortPathName($Path, $buffer, $buffer.Capacity)
if ($length -eq 0 -or $length -ge $buffer.Capacity) {
  throw "GetShortPathName failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
[Console]::Write($buffer.ToString())
