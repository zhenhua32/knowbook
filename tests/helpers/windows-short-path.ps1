param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Bind the same native API directly without starting an external C# compiler.
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('KnowBookTestShortPath'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('Native')
$type = $module.DefineType('KnowBookTestShortPathNative', [Reflection.TypeAttributes]'Public,Abstract,Sealed')
$method = $type.DefineMethod('GetShortPathNameW', [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
  [uint32], [Type[]]@([string], [Text.StringBuilder], [uint32]))
$dllImport = [Runtime.InteropServices.DllImportAttribute]
$fields = [Reflection.FieldInfo[]]@($dllImport.GetField('CharSet'), $dllImport.GetField('SetLastError'), $dllImport.GetField('ExactSpelling'))
$attribute = [Reflection.Emit.CustomAttributeBuilder]::new($dllImport.GetConstructor([Type[]]@([string])),
  [object[]]@('kernel32.dll'), $fields, [object[]]@([Runtime.InteropServices.CharSet]::Unicode, $true, $true))
$method.SetCustomAttribute($attribute)
$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
$native = $type.CreateType()
$buffer = [Text.StringBuilder]::new(32768)
$length = $native::GetShortPathNameW($Path, $buffer, $buffer.Capacity)
if ($length -eq 0 -or $length -ge $buffer.Capacity) {
  throw "GetShortPathName failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
[Console]::Write($buffer.ToString())
