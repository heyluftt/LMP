!macro LMP_REGISTER_PROGID PROGID DESCRIPTION ICON_NAME
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "${DESCRIPTION}"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$\"$INSTDIR\icons\filetypes\${ICON_NAME}.ico$\",0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!define LMP_THUMBNAIL_HANDLER "{e357fccd-a995-4576-b01f-234630154e96}"
!define LMP_WINDOWS_VIDEO_THUMBNAIL_PROVIDER "{9DBD2C50-62AD-11D0-B806-00C04FD706EC}"

!macro LMP_PATCH_TAURI_FILECLASS FILECLASS ICON_NAME
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\DefaultIcon" "" "$\"$INSTDIR\icons\filetypes\${ICON_NAME}.ico$\",0"
!macroend

!macro LMP_PATCH_TAURI_FILECLASS_ICONS
  ; Tauri's NSIS associations use these display class names when it creates
  ; default file classes. Keep them visually aligned with our ProgIDs.
  !insertmacro LMP_PATCH_TAURI_FILECLASS "LMP Video" "video"
  !insertmacro LMP_PATCH_TAURI_FILECLASS "LMP Audio" "audio"
  !insertmacro LMP_PATCH_TAURI_FILECLASS "LMP Images" "image"
  !insertmacro LMP_PATCH_TAURI_FILECLASS "LMP PDF" "pdf"
  !insertmacro LMP_PATCH_TAURI_FILECLASS "LMP Word Documents" "word"
  !insertmacro LMP_PATCH_TAURI_FILECLASS "LMP Text" "text"
!macroend

!macro LMP_PATCH_PDF_FILECLASS_ICONS
  WriteRegStr HKCU "Software\Classes\LMP.Pdf\DefaultIcon" "" "$\"$INSTDIR\icons\filetypes\pdf.ico$\",0"
  WriteRegStr HKCU "Software\Classes\LMP.pdf\DefaultIcon" "" "$\"$INSTDIR\icons\filetypes\pdf.ico$\",0"
  WriteRegStr HKCU "Software\Classes\LMP PDF\DefaultIcon" "" "$\"$INSTDIR\icons\filetypes\pdf.ico$\",0"
  WriteRegStr HKCU "Software\Classes\LMP_PDF\DefaultIcon" "" "$\"$INSTDIR\icons\filetypes\pdf.ico$\",0"
!macroend

!macro LMP_REGISTER_EXTENSION EXT PROGID
  WriteRegStr HKCU "Software\Classes\Applications\lmp.exe\SupportedTypes" ".${EXT}" ""
  WriteRegStr HKCU "Software\LMP\Capabilities\FileAssociations" ".${EXT}" "${PROGID}"
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithList\lmp.exe" "" ""
!macroend

!macro LMP_REGISTER_VIDEO_THUMBNAIL_CLASS FILECLASS
  WriteRegStr HKCU "Software\Classes\${FILECLASS}" "PerceivedType" "video"
  ReadRegStr $0 HKCU "Software\Classes\${FILECLASS}\ShellEx\${LMP_THUMBNAIL_HANDLER}" ""
  StrCmp $0 "" 0 +2
  WriteRegStr HKCU "Software\Classes\${FILECLASS}\ShellEx\${LMP_THUMBNAIL_HANDLER}" "" "${LMP_WINDOWS_VIDEO_THUMBNAIL_PROVIDER}"
!macroend

!macro LMP_UNREGISTER_VIDEO_THUMBNAIL_CLASS FILECLASS
  ReadRegStr $0 HKCU "Software\Classes\${FILECLASS}\ShellEx\${LMP_THUMBNAIL_HANDLER}" ""
  StrCmp $0 "${LMP_WINDOWS_VIDEO_THUMBNAIL_PROVIDER}" 0 +2
  DeleteRegKey HKCU "Software\Classes\${FILECLASS}\ShellEx\${LMP_THUMBNAIL_HANDLER}"
  DeleteRegKey /ifempty HKCU "Software\Classes\${FILECLASS}\ShellEx"
  DeleteRegValue HKCU "Software\Classes\${FILECLASS}" "PerceivedType"
!macroend

!macro LMP_REGISTER_VIDEO_EXTENSION EXT CONTENT_TYPE
  !insertmacro LMP_REGISTER_EXTENSION "${EXT}" "LMP.Video"
  WriteRegStr HKCU "Software\Classes\.${EXT}" "PerceivedType" "video"
  WriteRegStr HKCU "Software\Classes\.${EXT}" "Content Type" "${CONTENT_TYPE}"
  ReadRegStr $0 HKCU "Software\Classes\.${EXT}\ShellEx\${LMP_THUMBNAIL_HANDLER}" ""
  StrCmp $0 "" 0 +2
  WriteRegStr HKCU "Software\Classes\.${EXT}\ShellEx\${LMP_THUMBNAIL_HANDLER}" "" "${LMP_WINDOWS_VIDEO_THUMBNAIL_PROVIDER}"
!macroend

!macro LMP_UNREGISTER_EXTENSION EXT PROGID
  DeleteRegValue HKCU "Software\Classes\Applications\lmp.exe\SupportedTypes" ".${EXT}"
  DeleteRegValue HKCU "Software\LMP\Capabilities\FileAssociations" ".${EXT}"
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey HKCU "Software\Classes\.${EXT}\OpenWithList\lmp.exe"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithList"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}"
!macroend

!macro LMP_UNREGISTER_VIDEO_EXTENSION EXT
  ReadRegStr $0 HKCU "Software\Classes\.${EXT}\ShellEx\${LMP_THUMBNAIL_HANDLER}" ""
  StrCmp $0 "${LMP_WINDOWS_VIDEO_THUMBNAIL_PROVIDER}" 0 +2
  DeleteRegKey HKCU "Software\Classes\.${EXT}\ShellEx\${LMP_THUMBNAIL_HANDLER}"
  DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\ShellEx"
  DeleteRegValue HKCU "Software\Classes\.${EXT}" "PerceivedType"
  DeleteRegValue HKCU "Software\Classes\.${EXT}" "Content Type"
  !insertmacro LMP_UNREGISTER_EXTENSION "${EXT}" "LMP.Video"
!macroend

!macro LMP_REGISTER_VIDEO_EXTENSIONS
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "mp4" "video/mp4"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "mkv" "video/x-matroska"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "mov" "video/quicktime"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "avi" "video/x-msvideo"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "webm" "video/webm"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "m4v" "video/mp4"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "wmv" "video/x-ms-wmv"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "ts" "video/mp2t"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "mts" "video/mp2t"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "m2ts" "video/mp2t"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "mpeg" "video/mpeg"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "mpg" "video/mpeg"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "mpe" "video/mpeg"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "ogv" "video/ogg"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "3gp" "video/3gpp"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "3g2" "video/3gpp2"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "flv" "video/x-flv"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "f4v" "video/mp4"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "asf" "video/x-ms-asf"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "vob" "video/dvd"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "divx" "video/divx"
  !insertmacro LMP_REGISTER_VIDEO_EXTENSION "mxf" "application/mxf"
!macroend

!macro LMP_UNREGISTER_VIDEO_EXTENSIONS
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "mp4"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "mkv"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "mov"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "avi"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "webm"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "m4v"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "wmv"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "ts"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "mts"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "m2ts"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "mpeg"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "mpg"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "mpe"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "ogv"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "3gp"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "3g2"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "flv"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "f4v"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "asf"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "vob"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "divx"
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSION "mxf"
!macroend

!macro LMP_REGISTER_AUDIO_EXTENSIONS
  !insertmacro LMP_REGISTER_EXTENSION "mp3" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "flac" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "wav" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "m4a" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "aac" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "ogg" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "opus" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "wma" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "aiff" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "aif" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "oga" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "weba" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "caf" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "amr" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "mka" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "mp2" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "mpa" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "ac3" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "eac3" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "dts" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "dtshd" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "ape" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "alac" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "au" "LMP.Audio"
  !insertmacro LMP_REGISTER_EXTENSION "snd" "LMP.Audio"
!macroend

!macro LMP_UNREGISTER_AUDIO_EXTENSIONS
  !insertmacro LMP_UNREGISTER_EXTENSION "mp3" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "flac" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "wav" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "m4a" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "aac" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "ogg" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "opus" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "wma" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "aiff" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "aif" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "oga" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "weba" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "caf" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "amr" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "mka" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "mp2" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "mpa" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "ac3" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "eac3" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "dts" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "dtshd" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "ape" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "alac" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "au" "LMP.Audio"
  !insertmacro LMP_UNREGISTER_EXTENSION "snd" "LMP.Audio"
!macroend

!macro LMP_REGISTER_IMAGE_EXTENSIONS
  !insertmacro LMP_REGISTER_EXTENSION "jpg" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "jpeg" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "jfif" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "png" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "gif" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "webp" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "bmp" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "avif" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "svg" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "ico" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "tif" "LMP.Image"
  !insertmacro LMP_REGISTER_EXTENSION "tiff" "LMP.Image"
!macroend

!macro LMP_UNREGISTER_IMAGE_EXTENSIONS
  !insertmacro LMP_UNREGISTER_EXTENSION "jpg" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "jpeg" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "jfif" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "png" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "gif" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "webp" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "bmp" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "avif" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "svg" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "ico" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "tif" "LMP.Image"
  !insertmacro LMP_UNREGISTER_EXTENSION "tiff" "LMP.Image"
!macroend

!macro LMP_REGISTER_PDF_EXTENSIONS
  !insertmacro LMP_REGISTER_EXTENSION "pdf" "LMP.Pdf"
  WriteRegStr HKCU "Software\Classes\.pdf" "" "LMP.Pdf"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids" "LMP.Document"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids" "LMP.Pdf" ""
  !insertmacro LMP_PATCH_PDF_FILECLASS_ICONS
!macroend

!macro LMP_UNREGISTER_PDF_EXTENSIONS
  !insertmacro LMP_UNREGISTER_EXTENSION "pdf" "LMP.Pdf"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids" "LMP.Pdf"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids" "LMP.Document"
!macroend

!macro LMP_REGISTER_WORD_EXTENSIONS
  !insertmacro LMP_REGISTER_EXTENSION "doc" "LMP.Word"
  !insertmacro LMP_REGISTER_EXTENSION "docx" "LMP.Word"
  !insertmacro LMP_REGISTER_EXTENSION "docm" "LMP.Word"
  !insertmacro LMP_REGISTER_EXTENSION "dotx" "LMP.Word"
  !insertmacro LMP_REGISTER_EXTENSION "dotm" "LMP.Word"
  DeleteRegValue HKCU "Software\Classes\.doc\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Classes\.docx\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Classes\.docm\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Classes\.dotx\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Classes\.dotm\OpenWithProgids" "LMP.Document"
!macroend

!macro LMP_UNREGISTER_WORD_EXTENSIONS
  !insertmacro LMP_UNREGISTER_EXTENSION "doc" "LMP.Word"
  !insertmacro LMP_UNREGISTER_EXTENSION "docx" "LMP.Word"
  !insertmacro LMP_UNREGISTER_EXTENSION "docm" "LMP.Word"
  !insertmacro LMP_UNREGISTER_EXTENSION "dotx" "LMP.Word"
  !insertmacro LMP_UNREGISTER_EXTENSION "dotm" "LMP.Word"
  DeleteRegValue HKCU "Software\Classes\.doc\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Classes\.docx\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Classes\.docm\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Classes\.dotx\OpenWithProgids" "LMP.Document"
  DeleteRegValue HKCU "Software\Classes\.dotm\OpenWithProgids" "LMP.Document"
!macroend

!macro LMP_REGISTER_TEXT_EXTENSION EXT
  !insertmacro LMP_REGISTER_EXTENSION "${EXT}" "LMP.Text"
  ; "Edit with LMP" in the Explorer context menu, also for scripts whose default verb runs them.
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\LMP.Edit" "" "Edit with LMP"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\LMP.Edit" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\LMP.Edit\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro LMP_UNREGISTER_TEXT_EXTENSION EXT
  !insertmacro LMP_UNREGISTER_EXTENSION "${EXT}" "LMP.Text"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell\LMP.Edit"
  DeleteRegKey /ifempty HKCU "Software\Classes\SystemFileAssociations\.${EXT}\shell"
  DeleteRegKey /ifempty HKCU "Software\Classes\SystemFileAssociations\.${EXT}"
!macroend

!macro LMP_REGISTER_TEXT_EXTENSIONS
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "txt"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "md"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "markdown"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "log"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "json"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "jsonc"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "csv"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "tsv"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "xml"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "yaml"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "yml"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "toml"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "ini"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "conf"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "cfg"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "css"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "scss"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "sass"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "less"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "html"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "htm"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "xhtml"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "js"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "jsx"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "tsx"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "mjs"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "cjs"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "cts"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "vue"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "svelte"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "astro"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "rs"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "py"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "java"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "c"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "cpp"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "h"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "hpp"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "cs"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "go"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "php"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "rb"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "sh"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "ps1"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "bat"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "cmd"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "sql"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "lua"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "dart"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "kt"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "kts"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "swift"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "pl"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "r"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "gradle"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "text"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "diff"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "patch"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "properties"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "env"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "rst"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "tex"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "bash"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "zsh"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "psm1"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "psd1"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "reg"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "vbs"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "nfo"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "graphql"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "gql"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "proto"
  !insertmacro LMP_REGISTER_TEXT_EXTENSION "tf"
!macroend

!macro LMP_UNREGISTER_TEXT_EXTENSIONS
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "txt"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "md"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "markdown"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "log"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "json"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "jsonc"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "csv"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "tsv"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "xml"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "yaml"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "yml"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "toml"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "ini"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "conf"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "cfg"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "css"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "scss"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "sass"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "less"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "html"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "htm"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "xhtml"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "js"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "jsx"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "tsx"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "mjs"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "cjs"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "cts"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "vue"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "svelte"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "astro"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "rs"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "py"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "java"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "c"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "cpp"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "h"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "hpp"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "cs"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "go"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "php"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "rb"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "sh"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "ps1"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "bat"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "cmd"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "sql"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "lua"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "dart"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "kt"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "kts"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "swift"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "pl"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "r"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "gradle"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "text"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "diff"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "patch"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "properties"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "env"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "rst"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "tex"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "bash"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "zsh"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "psm1"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "psd1"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "reg"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "vbs"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "nfo"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "graphql"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "gql"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "proto"
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSION "tf"
!macroend

!macro LMP_REGISTER_OPEN_WITH
  DeleteRegValue HKCU "Software\RegisteredApplications" "LMP One"
  DeleteRegKey HKCU "Software\Classes\Applications\lmp-one.exe"
  DeleteRegKey HKCU "Software\Classes\Applications\LMP One.exe"
  DeleteRegKey HKCU "Software\Classes\Applications\LMP.exe"
  DeleteRegKey HKCU "Software\Classes\LMPOne.Media"
  DeleteRegKey HKCU "Software\Classes\LMPOne.MediaFile"
  DeleteRegKey HKCU "Software\Classes\LMPOne.Video"
  DeleteRegKey HKCU "Software\Classes\LMPOne.Audio"
  DeleteRegKey HKCU "Software\Classes\LMPOne.Images"
  DeleteRegKey HKCU "Software\Classes\LMPOne.Documents"
  DeleteRegKey HKCU "Software\Classes\LMP One.Media"
  DeleteRegKey HKCU "Software\Classes\LMP One.MediaFile"

  WriteRegStr HKCU "Software\Classes\Applications\lmp.exe" "FriendlyAppName" "LMP"
  WriteRegStr HKCU "Software\Classes\Applications\lmp.exe\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "Software\Classes\Applications\lmp.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  WriteRegStr HKCU "Software\LMP\Capabilities" "ApplicationName" "LMP"
  WriteRegStr HKCU "Software\LMP\Capabilities" "ApplicationDescription" "A calm native-first media and viewer suite for Windows."
  WriteRegStr HKCU "Software\LMP\Capabilities" "ApplicationIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKCU "Software\RegisteredApplications" "LMP" "Software\LMP\Capabilities"

  DeleteRegKey HKCU "Software\Classes\LMP.Document"

  !insertmacro LMP_REGISTER_PROGID "LMP.Video" "LMP video file" "video"
  !insertmacro LMP_REGISTER_VIDEO_THUMBNAIL_CLASS "LMP.Video"
  !insertmacro LMP_REGISTER_VIDEO_THUMBNAIL_CLASS "LMP Video"
  !insertmacro LMP_REGISTER_PROGID "LMP.Audio" "LMP audio file" "audio"
  !insertmacro LMP_REGISTER_PROGID "LMP.Image" "LMP image file" "image"
  !insertmacro LMP_REGISTER_PROGID "LMP.Pdf" "LMP PDF file" "pdf"
  !insertmacro LMP_REGISTER_PROGID "LMP.Word" "LMP Word extracted document" "word"
  !insertmacro LMP_REGISTER_PROGID "LMP.Text" "LMP text file" "text"

  !insertmacro LMP_REGISTER_VIDEO_EXTENSIONS
  !insertmacro LMP_REGISTER_AUDIO_EXTENSIONS
  !insertmacro LMP_REGISTER_IMAGE_EXTENSIONS
  !insertmacro LMP_REGISTER_PDF_EXTENSIONS
  !insertmacro LMP_REGISTER_WORD_EXTENSIONS
  !insertmacro LMP_REGISTER_TEXT_EXTENSIONS
  !insertmacro LMP_PATCH_TAURI_FILECLASS_ICONS
  !insertmacro LMP_PATCH_PDF_FILECLASS_ICONS

  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro LMP_UNREGISTER_OPEN_WITH
  !insertmacro LMP_UNREGISTER_VIDEO_EXTENSIONS
  !insertmacro LMP_UNREGISTER_AUDIO_EXTENSIONS
  !insertmacro LMP_UNREGISTER_IMAGE_EXTENSIONS
  !insertmacro LMP_UNREGISTER_PDF_EXTENSIONS
  !insertmacro LMP_UNREGISTER_WORD_EXTENSIONS
  !insertmacro LMP_UNREGISTER_TEXT_EXTENSIONS

  DeleteRegKey HKCU "Software\Classes\Applications\lmp.exe"
  !insertmacro LMP_UNREGISTER_VIDEO_THUMBNAIL_CLASS "LMP.Video"
  !insertmacro LMP_UNREGISTER_VIDEO_THUMBNAIL_CLASS "LMP Video"
  DeleteRegKey HKCU "Software\Classes\LMP.Video"
  DeleteRegKey HKCU "Software\Classes\LMP.Audio"
  DeleteRegKey HKCU "Software\Classes\LMP.Image"
  DeleteRegKey HKCU "Software\Classes\LMP.Pdf"
  DeleteRegKey HKCU "Software\Classes\LMP.pdf"
  DeleteRegKey HKCU "Software\Classes\LMP_PDF"
  DeleteRegKey HKCU "Software\Classes\LMP.Word"
  DeleteRegKey HKCU "Software\Classes\LMP.Document"
  DeleteRegKey HKCU "Software\Classes\LMP.Text"
  DeleteRegValue HKCU "Software\RegisteredApplications" "LMP"
  DeleteRegKey HKCU "Software\LMP\Capabilities"
  DeleteRegKey /ifempty HKCU "Software\LMP"

  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro LMP_REGISTER_OPEN_WITH
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LMP_UNREGISTER_OPEN_WITH
!macroend
