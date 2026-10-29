param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('tts', 'stt', 'list')]
    [string]$Mode,
    [string]$TextBase64 = '',
    [string]$InputPath = '',
    [string]$OutputPath = '',
    [string]$Voice = 'Microsoft Yaoyao'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech

try {
    if ($Mode -eq 'list') {
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object {
                @{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name; gender = $_.VoiceInfo.Gender.ToString() }
            })
            try {
                [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime] | Out-Null
                $voices += @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
                    @{ name = "onecore:$($_.Id)"; label = $_.DisplayName; culture = $_.Language; gender = $_.Gender.ToString() }
                })
            } catch { }
            @{ ok = $true; voices = $voices } | ConvertTo-Json -Depth 4 -Compress
        } finally { $synth.Dispose() }
        exit 0
    }
    if ($Mode -eq 'tts') {
        if (-not $TextBase64 -or -not $OutputPath) { throw 'Missing TTS text or output path' }
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextBase64))
        if ($Voice.StartsWith('onecore:')) {
            Add-Type -AssemblyName System.Runtime.WindowsRuntime
            [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime] | Out-Null
            [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime] | Out-Null
            $voiceId = $Voice.Substring(8)
            $selected = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Id -eq $voiceId } | Select-Object -First 1
            if (-not $selected) { throw "Selected voice is not installed: $voiceId" }
            $native = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
            try {
                $native.Voice = $selected
                $op = $native.SynthesizeTextToStreamAsync($text)
                $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
                $task = $method.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op))
                $task.Wait()
                $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result)
                try { $file = [System.IO.File]::Create($OutputPath); try { $stream.CopyTo($file) } finally { $file.Dispose() } } finally { $stream.Dispose() }
            } finally { $native.Dispose() }
            @{ ok = $true; path = $OutputPath } | ConvertTo-Json -Compress
            exit 0
        }
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            if ($Voice -and $synth.GetInstalledVoices().VoiceInfo.Name -notcontains $Voice) { throw "Selected voice is not installed: $Voice" }
            if ($Voice) {
                $synth.SelectVoice($Voice)
            }
            $synth.Rate = 2
            $synth.SetOutputToWaveFile($OutputPath)
            $synth.Speak($text)
            $synth.SetOutputToNull()
        } finally {
            $synth.Dispose()
        }
        @{ ok = $true; path = $OutputPath } | ConvertTo-Json -Compress
        exit 0
    }

    if (-not $InputPath) { throw 'Missing STT input path' }
    $recognizerInfo = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Culture.Name -eq 'zh-CN' } |
        Select-Object -First 1
    if (-not $recognizerInfo) { throw 'Windows zh-CN speech recognizer is not installed' }
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizerInfo)
    try {
        $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
        $recognizer.SetInputToWaveFile($InputPath)
        $result = $recognizer.Recognize([TimeSpan]::FromSeconds(15))
        if ($null -eq $result) {
            @{ ok = $true; text = ''; confidence = 0 } | ConvertTo-Json -Compress
        } else {
            @{ ok = $true; text = $result.Text; confidence = $result.Confidence } | ConvertTo-Json -Compress
        }
    } finally {
        $recognizer.Dispose()
    }
} catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
