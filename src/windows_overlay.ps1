param(
  [string]$WsUrl = "ws://127.0.0.1:8765",
  [int]$RefreshMs = 16
)

Add-Type -AssemblyName PresentationCore,PresentationFramework,WindowsBase,System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class OverlayWebSocketPump : IDisposable {
  private string latestModel;
  private string latestFrame;
  private volatile string status = "connecting";
  private readonly CancellationTokenSource cancel = new CancellationTokenSource();
  private long framesReceived;

  public string Status { get { return status; } }
  public long FramesReceived { get { return Interlocked.Read(ref framesReceived); } }

  public void Start(string url) {
    Task.Run(() => RunAsync(new Uri(url)));
  }

  public string TakeModel() {
    return Interlocked.Exchange(ref latestModel, null);
  }

  public string TakeFrame() {
    return Interlocked.Exchange(ref latestFrame, null);
  }

  private async Task RunAsync(Uri uri) {
    while (!cancel.IsCancellationRequested) {
      using (var ws = new ClientWebSocket()) {
        try {
          await ws.ConnectAsync(uri, cancel.Token);
          status = "connected";
          var buffer = new byte[65536];
          while (ws.State == WebSocketState.Open && !cancel.IsCancellationRequested) {
            using (var stream = new MemoryStream()) {
              WebSocketReceiveResult result;
              do {
                result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), cancel.Token);
                if (result.MessageType == WebSocketMessageType.Close) {
                  status = "server closed websocket";
                  break;
                }
                stream.Write(buffer, 0, result.Count);
              } while (!result.EndOfMessage);
              if (result.MessageType == WebSocketMessageType.Close) break;
              var json = Encoding.UTF8.GetString(stream.ToArray());
              if (json.IndexOf("\"type\":\"overlay_model\"", StringComparison.Ordinal) >= 0) {
                Interlocked.Exchange(ref latestModel, json);
              } else if (json.IndexOf("\"type\":\"overlay_frame\"", StringComparison.Ordinal) >= 0) {
                Interlocked.Exchange(ref latestFrame, json);
                Interlocked.Increment(ref framesReceived);
              }
            }
          }
        } catch (Exception ex) {
          if (!cancel.IsCancellationRequested) status = "receive failed: " + ex.Message;
        }
      }
      if (!cancel.IsCancellationRequested) {
        try { await Task.Delay(1000, cancel.Token); } catch { }
      }
    }
  }

  public void Dispose() {
    cancel.Cancel();
    cancel.Dispose();
  }
}
'@

$logDir = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "TGT2Telemetry\logs"
$logPath = Join-Path $logDir "overlay.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-OverlayLog($message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "o"), $message
  Add-Content -Path $logPath -Value $line -Encoding UTF8
}

Write-OverlayLog "start wsUrl=$WsUrl refreshMs=$RefreshMs"

$window = New-Object Windows.Window
$window.Title = "TGT2 Overlay"
$window.Width = 460
$window.Height = 260
$window.Topmost = $true
$window.ResizeMode = "CanResizeWithGrip"
$window.WindowStyle = "None"
$window.AllowsTransparency = $true
$window.ShowInTaskbar = $false
$window.Background = [Windows.Media.Brushes]::Transparent

$root = New-Object Windows.Controls.Grid
$root.Margin = "10"
$panelBrush = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb(210, 9, 12, 16))
$root.Background = $panelBrush
$root.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition -Property @{ Height = "Auto" }))
$root.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition -Property @{ Height = "*" }))
$root.RowDefinitions.Add((New-Object Windows.Controls.RowDefinition -Property @{ Height = "Auto" }))

$top = New-Object Windows.Controls.Grid
$top.Margin = "10,8,8,6"
$top.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition -Property @{ Width = "*" }))
$top.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition -Property @{ Width = "118" }))
$top.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition -Property @{ Width = "34" }))
$top.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition -Property @{ Width = "28" }))

$title = New-Object Windows.Controls.TextBlock
$title.Foreground = [Windows.Media.Brushes]::White
$title.FontFamily = "Segoe UI"
$title.FontSize = 14
$title.FontWeight = "SemiBold"
$title.Text = "TGT2 power curve"
$title.VerticalAlignment = "Center"
$title.Cursor = [Windows.Input.Cursors]::SizeAll
$title.Add_MouseLeftButtonDown({
  try { $window.DragMove() } catch {}
})
$top.Children.Add($title) | Out-Null

$opacitySlider = New-Object Windows.Controls.Slider
$opacitySlider.Minimum = 0.08
$opacitySlider.Maximum = 0.98
$opacitySlider.Value = 0.82
$opacitySlider.TickFrequency = 0.05
$opacitySlider.IsSnapToTickEnabled = $false
$opacitySlider.VerticalAlignment = "Center"
[Windows.Controls.Grid]::SetColumn($opacitySlider, 1)
$top.Children.Add($opacitySlider) | Out-Null

$opacityValue = New-Object Windows.Controls.TextBlock
$opacityValue.Foreground = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(139,148,158))
$opacityValue.FontFamily = "Consolas"
$opacityValue.FontSize = 11
$opacityValue.Text = "{0:n0}%" -f ($opacitySlider.Value * 100)
$opacityValue.VerticalAlignment = "Center"
$opacityValue.TextAlignment = "Right"
[Windows.Controls.Grid]::SetColumn($opacityValue, 2)
$top.Children.Add($opacityValue) | Out-Null

$closeButton = New-Object Windows.Controls.Button
$closeButton.Content = [char]0x00D7
$closeButton.FontFamily = "Segoe UI"
$closeButton.FontSize = 15
$closeButton.Foreground = [Windows.Media.Brushes]::White
$closeButton.Background = [Windows.Media.Brushes]::Transparent
$closeButton.BorderThickness = "0"
$closeButton.Cursor = [Windows.Input.Cursors]::Hand
$closeButton.ToolTip = "Close overlay"
[Windows.Controls.Grid]::SetColumn($closeButton, 3)
$top.Children.Add($closeButton) | Out-Null
$closeButton.Add_Click({ $window.Close() })

$opacitySlider.Add_ValueChanged({
  $value = [Math]::Max(0.08, [Math]::Min(0.98, $opacitySlider.Value))
  $alpha = [byte][Math]::Round($value * 255)
  $panelBrush.Color = [Windows.Media.Color]::FromArgb($alpha, 9, 12, 16)
  $opacityValue.Text = "{0:n0}%" -f ($value * 100)
  Write-OverlayLog ("background opacity={0:n2}" -f $value)
})

$root.Children.Add($top) | Out-Null

$canvas = New-Object Windows.Controls.Canvas
$canvas.Background = [Windows.Media.Brushes]::Transparent
$canvas.Margin = "10,0,10,0"
$canvas.ClipToBounds = $true
[Windows.Controls.Grid]::SetRow($canvas, 1)
$root.Children.Add($canvas) | Out-Null

$liveCanvas = New-Object Windows.Controls.Canvas
$liveCanvas.Background = [Windows.Media.Brushes]::Transparent
$liveCanvas.Margin = "10,0,10,0"
$liveCanvas.ClipToBounds = $true
$liveCanvas.IsHitTestVisible = $false
[Windows.Controls.Grid]::SetRow($liveCanvas, 1)
$root.Children.Add($liveCanvas) | Out-Null

$footer = New-Object Windows.Controls.TextBlock
$footer.Foreground = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(210,217,224))
$footer.FontFamily = "Consolas"
$footer.FontSize = 12
$footer.Margin = "10,6,10,8"
$footer.Text = "Waiting for telemetry..."
[Windows.Controls.Grid]::SetRow($footer, 2)
$root.Children.Add($footer) | Out-Null
$window.Content = $root

$pump = New-Object OverlayWebSocketPump
$pump.Start($WsUrl)
$lastModel = $null
$lastFrame = $null
$lastChartKey = ""
$lastGearOverlayKey = ""
$lastMessageAt = [DateTime]::MinValue
$lastWsError = ""
$renderPending = $false
$framesReceived = 0
$framesCoalesced = 0
$frameSeqGaps = 0
$lastFrameSeq = 0
$lastWireAgeMs = -1
$nextStatsAt = [DateTime]::UtcNow.AddSeconds(2)

function Add-Line($x1, $y1, $x2, $y2, $color, $thickness, $dash = $false) {
  $line = New-Object Windows.Shapes.Line
  $line.X1 = $x1; $line.Y1 = $y1; $line.X2 = $x2; $line.Y2 = $y2
  $line.Stroke = New-Object Windows.Media.SolidColorBrush $color
  $line.StrokeThickness = $thickness
  if ($dash) {
    $dashArray = New-Object Windows.Media.DoubleCollection
    $dashArray.Add(4)
    $dashArray.Add(4)
    $line.StrokeDashArray = $dashArray
  }
  $canvas.Children.Add($line) | Out-Null
}

function Add-Text($text, $x, $y, $size, $color) {
  $tb = New-Object Windows.Controls.TextBlock
  $tb.Text = $text
  $tb.FontFamily = "Consolas"
  $tb.FontSize = $size
  $tb.Foreground = New-Object Windows.Media.SolidColorBrush $color
  [Windows.Controls.Canvas]::SetLeft($tb, $x)
  [Windows.Controls.Canvas]::SetTop($tb, $y)
  $canvas.Children.Add($tb) | Out-Null
}

function Add-LiveLine($x1, $y1, $x2, $y2, $color, $thickness, $dash = $false) {
  $line = New-Object Windows.Shapes.Line
  $line.X1 = $x1; $line.Y1 = $y1; $line.X2 = $x2; $line.Y2 = $y2
  $line.Stroke = New-Object Windows.Media.SolidColorBrush $color
  $line.StrokeThickness = $thickness
  if ($dash) {
    $dashArray = New-Object Windows.Media.DoubleCollection
    $dashArray.Add(4)
    $dashArray.Add(4)
    $line.StrokeDashArray = $dashArray
  }
  $liveCanvas.Children.Add($line) | Out-Null
}

function Add-LiveText($text, $x, $y, $size, $color) {
  $tb = New-Object Windows.Controls.TextBlock
  $tb.Text = $text
  $tb.FontFamily = "Consolas"
  $tb.FontSize = $size
  $tb.Foreground = New-Object Windows.Media.SolidColorBrush $color
  [Windows.Controls.Canvas]::SetLeft($tb, $x)
  [Windows.Controls.Canvas]::SetTop($tb, $y)
  $liveCanvas.Children.Add($tb) | Out-Null
}

function Add-LiveRectangle($x, $y, $width, $height, $fillColor, $strokeColor, $strokeThickness) {
  $rect = New-Object Windows.Shapes.Rectangle
  $rect.Width = $width
  $rect.Height = $height
  if ($null -ne $fillColor) { $rect.Fill = New-Object Windows.Media.SolidColorBrush $fillColor }
  if ($null -ne $strokeColor) { $rect.Stroke = New-Object Windows.Media.SolidColorBrush $strokeColor }
  $rect.StrokeThickness = $strokeThickness
  [Windows.Controls.Canvas]::SetLeft($rect, $x)
  [Windows.Controls.Canvas]::SetTop($rect, $y)
  $liveCanvas.Children.Add($rect) | Out-Null
}

function Lookup-Hp($curve, [double]$rpm) {
  if ($null -eq $curve -or $curve.Count -lt 2) { return $null }
  if ($rpm -lt [double]$curve[0].rpm -or $rpm -gt [double]$curve[$curve.Count - 1].rpm) { return $null }
  for ($i = 1; $i -lt $curve.Count; $i++) {
    $lo = $curve[$i - 1]
    $hi = $curve[$i]
    if ([double]$lo.rpm -le $rpm -and [double]$hi.rpm -ge $rpm) {
      $span = [double]$hi.rpm - [double]$lo.rpm
      if ($span -le 0) { return [double]$lo.hp }
      $t = ($rpm - [double]$lo.rpm) / $span
      return [double]$lo.hp + $t * ([double]$hi.hp - [double]$lo.hp)
    }
  }
  return $null
}

function Draw-Overlay($state) {
  $w = [Math]::Max(1, $canvas.ActualWidth)
  $h = [Math]::Max(1, $canvas.ActualHeight)
  $padL = 42; $padR = 48; $padT = 16; $padB = 30
  $plotW = [Math]::Max(1, $w - $padL - $padR)
  $plotH = [Math]::Max(1, $h - $padT - $padB)

  $grid = [Windows.Media.Color]::FromRgb(48,54,61)
  $dim = [Windows.Media.Color]::FromRgb(139,148,158)
  $blue = [Windows.Media.Color]::FromRgb(88,166,255)
  $green = [Windows.Media.Color]::FromRgb(63,185,80)
  $red = [Windows.Media.Color]::FromRgb(248,81,73)
  $yellow = [Windows.Media.Color]::FromRgb(210,153,34)

  $tel = $state.telemetry
  $car = $state.car
  $curve = @()
  if ($car -and $car.powerCurve) { $curve = @($car.powerCurve) }
  $chartKey = "{0}:{1}:{2}:{3:n0}:{4:n0}" -f $state.modelTs, $(if ($car) { $car.powerBins } else { 0 }), $(if ($car) { $car.peakHpRpm } else { 0 }), $w, $h
  $redrawModel = $chartKey -ne $script:lastChartKey
  $liveCanvas.Children.Clear()
  $brakeRatio = if ($tel) { [double]$tel.brake } else { [double]0.0 }
  if ($brakeRatio -lt 0.0) { $brakeRatio = 0.0 }
  if ($brakeRatio -gt 1.0) { $brakeRatio = 1.0 }
  $brakeX = $w - 24
  $brakeW = 16
  $brakeFillH = $plotH * $brakeRatio
  Add-LiveRectangle $brakeX $padT $brakeW $plotH ([Windows.Media.Color]::FromArgb(70, 248, 81, 73)) $grid 1
  if ($brakeFillH -gt 0) {
    Add-LiveRectangle $brakeX ($padT + $plotH - $brakeFillH) $brakeW $brakeFillH $red $null 0
  }

  if ($curve.Count -lt 3) {
    if ($redrawModel) {
      $canvas.Children.Clear()
      Add-Text "Learning curve..." ($w / 2 - 54) ($h / 2 - 10) 14 $dim
      $script:lastChartKey = $chartKey
    }
    $rpm = if ($tel) { [int]$tel.rpm } else { 0 }
    $speed = if ($tel) { [double]$tel.speedKmh } else { 0 }
    $footer.Text = ("G{0}  {1} RPM  {2:n0} km/h  samples {3}" -f $(if($tel){$tel.gear}else{"-"}), $rpm, $speed, $(if($car){$car.totalSamples}else{0}))
    return
  }

  $minRpm = ($curve | Measure-Object -Property rpm -Minimum).Minimum
  $maxRpm = ($curve | Measure-Object -Property rpm -Maximum).Maximum
  $maxHp = ($curve | Measure-Object -Property hp -Maximum).Maximum
  if ($tel -and $tel.maxRpm -gt $maxRpm) { $maxRpm = $tel.maxRpm }
  $hpCeil = [Math]::Max(100, [Math]::Ceiling($maxHp / 50) * 50)
  $rpmRange = [Math]::Max(1, $maxRpm - $minRpm)

  $xOf = { param($rpm) $padL + (($rpm - $minRpm) / $rpmRange) * $plotW }
  $yOf = { param($hp) $padT + $plotH - (($hp / $hpCeil) * $plotH) }

  if ($redrawModel) {
    $canvas.Children.Clear()
    for ($i = 0; $i -le 4; $i++) {
      $y = $padT + $plotH * $i / 4
      Add-Line $padL $y ($w - $padR) $y $grid 1
    }
    for ($rpmTick = [Math]::Ceiling($minRpm / 1000) * 1000; $rpmTick -le $maxRpm; $rpmTick += 1000) {
      $x = & $xOf $rpmTick
      Add-Line $x $padT $x ($padT + $plotH) $grid 1
      Add-Text ([string][int]$rpmTick) ($x - 14) ($h - 22) 10 $dim
    }
    for ($i = 0; $i -le 4; $i++) {
      $hpLabel = $hpCeil * (4 - $i) / 4
      Add-Text ([string][int]$hpLabel) 2 ($padT + $plotH * $i / 4 - 7) 10 $dim
    }

    $poly = New-Object Windows.Shapes.Polyline
    $poly.Stroke = New-Object Windows.Media.SolidColorBrush $blue
    $poly.StrokeThickness = 2.4
    foreach ($pt in $curve) {
      $px = & $xOf ([double]$pt.rpm)
      $py = & $yOf ([double]$pt.hp)
      $poly.Points.Add((New-Object Windows.Point -ArgumentList $px, $py))
    }
    $canvas.Children.Add($poly) | Out-Null
    $script:lastChartKey = $chartKey
  }

  $gearRows = @()
  $gearSkip = @()
  if ($car -and $car.gears) {
    foreach ($prop in $car.gears.PSObject.Properties) {
      $gearNum = 0
      if ([int]::TryParse([string]$prop.Name, [ref]$gearNum) -and $gearNum -ge 1 -and $gearNum -le 10) {
        $info = $prop.Value
        if ($info -and $null -ne $info.leftRpm -and $null -ne $info.rightRpm) {
          $leftRpm = [double]$info.leftRpm
          $rightRpm = [double]$info.rightRpm
          if ($rightRpm -gt $leftRpm) {
            $gearRows += [pscustomobject]@{ gear = $gearNum; left = $leftRpm; right = $rightRpm; source = $info.source; context = $info.context }
          } else {
            $gearSkip += ("G{0}:{1:n0}>{2:n0}" -f $gearNum, $leftRpm, $rightRpm)
          }
        } elseif ($info -and $null -ne $info.unavailableReason) {
          $gearSkip += ("G{0}:{1}" -f $gearNum, $info.unavailableReason)
        }
      }
    }
  }
  $gearRows = @($gearRows | Sort-Object gear)
  if ($gearRows.Count -gt 0) {
    $rowH = 7.0
    $rowGap = 3.0
    $baseY = $padT + $plotH - 5
    foreach ($row in $gearRows) {
      $left = [Math]::Max($minRpm, [Math]::Min($maxRpm, [double]$row.left))
      $right = [Math]::Max($minRpm, [Math]::Min($maxRpm, [double]$row.right))
      $x1 = & $xOf $left
      $x2 = & $xOf $right
      $width = [Math]::Max(3, $x2 - $x1)
      $y = $baseY - ([double]($row.gear - 1) * ($rowH + $rowGap)) - $rowH
      if ($y -lt $padT) { continue }
      $fill = if ($tel -and [int]$tel.gear -eq [int]$row.gear) { [Windows.Media.Color]::FromArgb(125, 63, 185, 80) } else { [Windows.Media.Color]::FromArgb(70, 88, 166, 255) }
      $stroke = if ($tel -and [int]$tel.gear -eq [int]$row.gear) { $green } else { [Windows.Media.Color]::FromArgb(120, 88, 166, 255) }
      Add-LiveRectangle $x1 $y $width $rowH $fill $stroke 1
    }
  }
  $gearNames = if ($gearRows.Count -gt 0) { ($gearRows | ForEach-Object { "G$($_.gear)[$([int]$_.left)-$([int]$_.right)]" }) -join "," } else { "none" }
  $skipText = if ($gearSkip.Count -gt 0) { " skip=" + ($gearSkip -join ",") } else { "" }
  $gearKey = "{0}:{1}:{2}" -f $state.modelTs, $gearNames, $skipText
  if ($gearKey -ne $script:lastGearOverlayKey) {
    Write-OverlayLog ("gearOverlay rows={0} {1}{2}" -f $gearRows.Count, $gearNames, $skipText)
    $script:lastGearOverlayKey = $gearKey
  }

  if ($tel) {
    $rpm = [double]$tel.rpm
    $curveHp = Lookup-Hp $curve $rpm
    if ($null -eq $curveHp) { $curveHp = [double]$tel.powerHp }
    $x = & $xOf $rpm
    $y = & $yOf $curveHp
    Add-LiveLine $x $padT $x ($padT + $plotH) $yellow 1 $true

    $dot = New-Object Windows.Shapes.Ellipse
    $dot.Width = 12; $dot.Height = 12
    $dot.Fill = New-Object Windows.Media.SolidColorBrush $red
    $dot.Stroke = [Windows.Media.Brushes]::White
    $dot.StrokeThickness = 1
    [Windows.Controls.Canvas]::SetLeft($dot, $x - 6)
    [Windows.Controls.Canvas]::SetTop($dot, $y - 6)
    $liveCanvas.Children.Add($dot) | Out-Null

    if ($gearRows.Count -gt 0 -and [int]$tel.gear -ge 1 -and [int]$tel.gear -le 10) {
      $gearRow = @($gearRows | Where-Object { [int]$_.gear -eq [int]$tel.gear } | Select-Object -First 1)
      if ($gearRow.Count -gt 0) {
        $rowH = 7.0
        $rowGap = 3.0
        $baseY = $padT + $plotH - 5
        $dotRpm = [Math]::Max([double]$gearRow[0].left, [Math]::Min([double]$gearRow[0].right, $rpm))
        $dotX = & $xOf ([Math]::Max($minRpm, [Math]::Min($maxRpm, $dotRpm)))
        $dotY = $baseY - ([double]([int]$tel.gear - 1) * ($rowH + $rowGap)) - ($rowH / 2)
        if ($dotY -ge $padT -and $dotY -le ($padT + $plotH)) {
          $gearDot = New-Object Windows.Shapes.Ellipse
          $gearDot.Width = 7; $gearDot.Height = 7
          $gearDot.Fill = [Windows.Media.Brushes]::White
          $gearDot.Stroke = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromArgb(180, 13,17,23))
          $gearDot.StrokeThickness = 1
          [Windows.Controls.Canvas]::SetLeft($gearDot, $dotX - 3.5)
          [Windows.Controls.Canvas]::SetTop($gearDot, $dotY - 3.5)
          $liveCanvas.Children.Add($gearDot) | Out-Null
        }
      }
    }

    Add-LiveText ("{0:n0} HP" -f $curveHp) ([Math]::Min($w - 74, $x + 8)) ([Math]::Max(2, $y - 20)) 11 $red
    $as = if ($state.autoshift.enabled) { "AUTO" } else { "MAN" }
    $footer.Text = ("{0}  G{1}  {2:n0} RPM  {3:n0} km/h  {4:n0} HP  peak {5:n0}@{6}" -f $as, $tel.gear, $tel.rpm, $tel.speedKmh, $curveHp, $car.peakHp, $car.peakHpRpm)
  }
}

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds($RefreshMs)
$timer.Add_Tick({
  try {
    $modelJson = $script:pump.TakeModel()
    if ($modelJson) {
      $state = $modelJson | ConvertFrom-Json
      $script:lastModel = $state
      $script:lastChartKey = ""
      $script:renderPending = $true
      Write-OverlayLog ("model curvePoints={0} samples={1}" -f @($state.car.powerCurve).Count, $state.car.totalSamples)
    }
    $frameJson = $script:pump.TakeFrame()
    if ($frameJson) {
      $state = $frameJson | ConvertFrom-Json
      if ($script:renderPending -and $script:lastFrame) { $script:framesCoalesced++ }
      $script:lastFrame = $state
      $script:lastMessageAt = [DateTime]::UtcNow
      $seq = [long]$state.seq
      if ($script:lastFrameSeq -gt 0 -and $seq -gt $script:lastFrameSeq + 1) {
        $script:frameSeqGaps += $seq - $script:lastFrameSeq - 1
      }
      $script:lastFrameSeq = $seq
      $script:lastWireAgeMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - ([double]$state.ts * 1000)
      $script:renderPending = $true
    }
    $script:framesReceived = $script:pump.FramesReceived
    $script:lastWsError = $script:pump.Status
  } catch {
    Write-OverlayLog "state failed: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
  }

  try {
    if ([DateTime]::UtcNow -ge $script:nextStatsAt) {
      Write-OverlayLog ("frames={0} coalesced={1} seq={2} gaps={3} wireAgeMs={4:n0}" -f $script:framesReceived, $script:framesCoalesced, $script:lastFrameSeq, $script:frameSeqGaps, $script:lastWireAgeMs)
      $script:nextStatsAt = [DateTime]::UtcNow.AddSeconds(2)
    }
    if ($script:renderPending -and $script:lastModel -and $script:lastFrame) {
      $view = [PSCustomObject]@{
        modelTs = $script:lastModel.ts
        telemetry = $script:lastFrame.telemetry
        car = $script:lastModel.car
        autoshift = $script:lastModel.autoshift
      }
      Draw-Overlay $view
      $script:renderPending = $false
    } elseif (-not $script:lastFrame) {
      $canvas.Children.Clear()
      Add-Text "Connecting websocket..." 96 72 14 ([Windows.Media.Color]::FromRgb(139,148,158))
      if ($script:lastWsError -and $script:lastWsError -ne "connected") {
        Add-Text ($script:lastWsError.Substring(0, [Math]::Min(50, $script:lastWsError.Length))) 24 98 11 ([Windows.Media.Color]::FromRgb(248,81,73))
      }
      $footer.Text = $WsUrl
    }
  } catch {
    $msg = "render failed: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
    Write-OverlayLog $msg
    $canvas.Children.Clear()
    Add-Text "Overlay render failed" 104 72 14 ([Windows.Media.Color]::FromRgb(248,81,73))
    Add-Text ($_.Exception.Message.Substring(0, [Math]::Min(46, $_.Exception.Message.Length))) 24 98 11 ([Windows.Media.Color]::FromRgb(139,148,158))
    $footer.Text = $WsUrl
  }
})
$window.Add_Closed({ $timer.Stop(); $script:pump.Dispose(); Write-OverlayLog "window closed" })
$timer.Start()
$window.ShowDialog() | Out-Null
