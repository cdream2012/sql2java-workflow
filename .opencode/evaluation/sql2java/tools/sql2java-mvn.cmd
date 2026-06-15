@REM =============================================================================
@REM sql2java-mvn.cmd -- Windows Maven launcher for sql2java evaluation
@REM Supports: Win64 / Kylin ARM64 / Kylin x86_64
@REM
@REM Auto-detect OS+CPU, resolve JAVA_HOME, use isolated Maven repo.
@REM Usage:
@REM   sql2java-mvn.cmd [maven args]   -- run mvn
@REM   sql2java-mvn.cmd --show-env     -- show detected environment
@REM =============================================================================
@echo off
setlocal EnableExtensions

@REM --- Locate tools directory ---
@REM %~dp0 works when called directly; %CD% fallback for Git Bash / shell wrappers
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR%"=="" set "SCRIPT_DIR=%CD%"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
@REM If SCRIPT_DIR does not contain the Maven dir, search upward
set "MAVEN_DIR=%SCRIPT_DIR%\apache-maven-3.9.16"
if not exist "%MAVEN_DIR%\bin\mvn.cmd" (
    @REM Try parent dir (shell may have cd'd into a subdirectory)
    set "MAVEN_DIR=%SCRIPT_DIR%\..\apache-maven-3.9.16"
    if not exist "%MAVEN_DIR%\bin\mvn.cmd" (
        echo [ERROR] Maven not found near %SCRIPT_DIR%
        echo         Ensure apache-maven-3.9.16 is under tools\
        exit /b 1
    )
)
@REM Normalize MAVEN_DIR (remove relative ..\)
for %%m in ("%MAVEN_DIR%") do set "MAVEN_DIR=%%~fm"

@REM --- Detect platform ---
set "PLAT_OS=windows"
if "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "PLAT_ARCH=x86_64"
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "PLAT_ARCH=aarch64"
if not defined PLAT_ARCH set "PLAT_ARCH=x86_64"
set "PLATFORM=%PLAT_OS%/%PLAT_ARCH%"

@REM --- Resolve JAVA_HOME ---
@REM Strip trailing backslash first
if defined JAVA_HOME (
    if "%JAVA_HOME:~-1%"=="\" set "JAVA_HOME=%JAVA_HOME:~0,-1%"
)
if defined JAVA_HOME (
    if exist "%JAVA_HOME%\bin\java.exe" goto :javaOk
    echo [WARN] JAVA_HOME set but java.exe missing: %JAVA_HOME%
)

@REM --- Search PATH for java.exe ---
set "J_PATH="
for %%i in (java.exe) do set "J_PATH=%%~$PATH:i"
if defined J_PATH (
    for %%j in ("%J_PATH%") do set "J_BIN=%%~dpj"
    if "%J_BIN:~-1%"=="\" set "J_BIN=%J_BIN:~0,-1%"
    @REM J_BIN is ...\bin, JAVA_HOME = parent dir
    for %%k in ("%J_BIN%\..") do set "JAVA_HOME=%%~fk"
    if "%JAVA_HOME:~-1%"=="\" set "JAVA_HOME=%JAVA_HOME:~0,-1%"
    echo [INFO] Auto JAVA_HOME=%JAVA_HOME% from PATH
    goto :javaOk
)

@REM --- Search common JDK install paths ---
for %%d in (
    "C:\Program Files\Microsoft\jdk-17.0.18.8-hotspot"
) do (
    if exist "%%~d\bin\java.exe" (
        set "JAVA_HOME=%%~d"
        echo [INFO] Auto JAVA_HOME=%%~d
        goto :javaOk
    )
)

echo [ERROR] JDK not found. Set JAVA_HOME or add java to PATH.
echo          Platform: %PLATFORM%
exit /b 1

:javaOk

@REM --- Verify Java version >= 8 ---
set "J_MAJOR=0"
set "J_VER=unknown"
set "JAVACMD=%JAVA_HOME%\bin\java.exe"
"%JAVACMD%" -version > "%TEMP%\sql2java-jver.txt" 2>&1
for /f "tokens=3" %%v in ('findstr /i "version" "%TEMP%\sql2java-jver.txt"') do set "J_VER=%%~v"
del /q "%TEMP%\sql2java-jver.txt" 2>nul
for /f "tokens=1,2 delims=." %%a in ("%J_VER%") do (
    if "%%a"=="1" (
        set "J_MAJOR=%%b"
    ) else (
        set "J_MAJOR=%%a"
    )
)
if %J_MAJOR% LSS 8 (
    echo [ERROR] Java version too low: %J_VER% (need >= 8)
    exit /b 1
)

@REM --- Setup isolated Maven local repo ---
set "EVAL_REPO=%MAVEN_DIR%\..\m2-repo-%PLAT_OS%-%PLAT_ARCH%"
for %%r in ("%EVAL_REPO%") do set "EVAL_REPO=%%~fr"
if not exist "%EVAL_REPO%" mkdir "%EVAL_REPO%"

@REM --- Show environment (--show-env) ---
if "%~1"=="--show-env" (
    echo ========================================
    echo sql2java-mvn environment check
    echo ========================================
    echo   Platform:      %PLATFORM%
    echo   Maven dir:     %MAVEN_DIR%
    echo   JAVA_HOME:     %JAVA_HOME%
    echo   Java version:  %J_VER% (major=%J_MAJOR%)
    echo   Local repo:    %EVAL_REPO%
    echo ========================================
    exit /b 0
)

@REM --- Execute Maven ---
set "MAVEN_HOME=%MAVEN_DIR%"
echo [mvn] %PLATFORM% | JAVA_HOME=%JAVA_HOME% | repo=%EVAL_REPO%

call "%MAVEN_DIR%\bin\mvn.cmd" -Dmaven.repo.local="%EVAL_REPO%" %*
exit /b %ERRORLEVEL%
