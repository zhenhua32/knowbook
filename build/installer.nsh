!macro customUnInstall
  ; An update replaces binaries but preserves the reviewed startup registration
  ; and plugin state. Only a genuine application uninstall removes persistence.
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 knowbookCleanupMissing
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --knowbook-uninstall-cleanup' $R0
    ${if} $R0 != 0
      MessageBox MB_OK|MB_ICONSTOP "KnowBook could not clean host-managed plugin startup items or background processes (exit $R0). The application has been kept so cleanup can be retried. See system-plugin-uninstall-cleanup.json in the KnowBook data directory." /SD IDOK
      SetErrorLevel 24
      Abort "Host-managed plugin cleanup failed."
    ${endif}
    Goto knowbookCleanupDone
    knowbookCleanupMissing:
      MessageBox MB_OK|MB_ICONSTOP "The KnowBook executable is missing. Reinstall this version before uninstalling so its plugin startup items and background processes can be cleaned." /SD IDOK
      SetErrorLevel 24
      Abort "KnowBook cleanup executable missing."
    knowbookCleanupDone:
  ${endif}
!macroend
