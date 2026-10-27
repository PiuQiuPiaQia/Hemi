using System;
using System.Drawing;
using System.Windows.Forms;
using System.IO;
using System.Text;
using System.Collections.Generic;

public static class HemiDesktopFixture {
  static void AtomicWrite(string file, string value) {
    var temporary=file+".tmp";File.WriteAllText(temporary,value,new UTF8Encoding(false));
    if(File.Exists(file))File.Replace(temporary,file,null);else File.Move(temporary,file);
  }
  [STAThread] public static void Main(string[] args) {
    Application.EnableVisualStyles();
    var title=args.Length>0?args[0]:"HEMI Windows Desktop Fixture";
    var form=new Form {Text=title,ClientSize=new Size(640,600),AutoScaleMode=AutoScaleMode.None};
    var input=new TextBox {Name="HemiInput",AccessibleName="HemiInput",Multiline=true,Bounds=new Rectangle(30,30,560,150)};
    var secondary=new TextBox {Name="HemiSecondary",AccessibleName="HemiSecondary",Bounds=new Rectangle(30,185,560,24)};
    var result=new TextBox {Name="HemiResult",AccessibleName="HemiResult",Text="Waiting",Multiline=true,ReadOnly=true,TabStop=false,Bounds=new Rectangle(30,550,560,40)};
    var apply=new Button {Name="HemiApply",AccessibleName="HemiApply",Text="Apply",Bounds=new Rectangle(30,220,160,35)};
    var check=new CheckBox {Name="HemiCheck",AccessibleName="HemiCheck",Text="Toggle proof",Bounds=new Rectangle(230,220,220,35)};
    var readOnly=new TextBox {Name="HemiReadOnly",AccessibleName="HemiReadOnly",Text="READ_ONLY",ReadOnly=true,Bounds=new Rectangle(30,270,560,24)};
    var list=new ListBox {Name="HemiScrollList",AccessibleName="HemiScrollList",Bounds=new Rectangle(30,310,560,170)};
    for(int i=0;i<100;i++)list.Items.Add("Row "+i.ToString("D3"));
    var open=new Button {AccessibleName="HemiOpenWindow",Text="Second window",Bounds=new Rectangle(30,500,145,32)};
    var modal=new Button {AccessibleName="HemiOpenDialog",Text="Dialog",Bounds=new Rectangle(190,500,110,32)};
    var slow=new Button {AccessibleName="HemiSlow",Text="Slow action",Bounds=new Rectangle(320,500,130,32)};
    var close=new Button {AccessibleName="HemiClose",Text="Close",Bounds=new Rectangle(470,500,120,32)};
    Form other=null;string otherValue="",dialogResult="";int applied=0,slowCount=0;bool dialogOpen=false;
    string previousDetails=null;
    Action save=()=>{
      if(args.Length<2)return;
      AtomicWrite(args[1],Convert.ToBase64String(Encoding.UTF8.GetBytes(input.Text))+"\n"+Convert.ToBase64String(Encoding.UTF8.GetBytes(result.Text)));
    };
    Action details=()=>{
      if(args.Length<2)return;
      var values=new Dictionary<string,string>{{"input",input.Text},{"secondary",secondary.Text},{"applied",result.Text},{"applyCount",applied.ToString()},{"checked",check.Checked?"1":"0"},{"topIndex",list.TopIndex.ToString()},{"readOnly",readOnly.Text},{"otherValue",otherValue},{"otherOpen",other!=null&&!other.IsDisposed?"1":"0"},{"dialogOpen",dialogOpen?"1":"0"},{"dialogResult",dialogResult},{"slowCount",slowCount.ToString()}};
      var text=new StringBuilder();foreach(var item in values)text.Append(item.Key).Append('=').Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(item.Value))).Append('\n');
      var value=text.ToString();if(value!=previousDetails){AtomicWrite(args[1]+".details",value);previousDetails=value;}
    };
    input.TextChanged+=(s,e)=>{save();details();};secondary.TextChanged+=(s,e)=>details();
    apply.Click+=(s,e)=>{result.Text=input.Text;applied++;save();details();};check.CheckedChanged+=(s,e)=>details();
    open.Click+=(s,e)=>{
      if(other!=null&&!other.IsDisposed){other.Show();return;}
      other=new Form {Text=title+" SECONDARY",ClientSize=new Size(360,170),AutoScaleMode=AutoScaleMode.None};
      var edit=new TextBox {AccessibleName="HemiWindowInput",Bounds=new Rectangle(20,30,300,28)};
      edit.TextChanged+=(sender,evt)=>{otherValue=edit.Text;details();};other.Controls.Add(edit);other.FormClosed+=(sender,evt)=>details();other.Show(form);details();
    };
    modal.Click+=(s,e)=>form.BeginInvoke(new Action(()=>{
      using(var dialog=new Form {Text=title+" DIALOG",ClientSize=new Size(300,150),AutoScaleMode=AutoScaleMode.None}){
        var ok=new Button {AccessibleName="HemiDialogOK",Text="OK",DialogResult=DialogResult.OK,Bounds=new Rectangle(30,60,100,35)};
        dialog.Controls.Add(ok);dialog.AcceptButton=ok;dialogOpen=true;details();dialogResult=dialog.ShowDialog(form).ToString();dialogOpen=false;details();
      }
    }));
    slow.Click+=(s,e)=>{slowCount++;details();System.Threading.Thread.Sleep(2500);};close.Click+=(s,e)=>form.Close();
    form.Controls.AddRange(new Control[]{input,secondary,apply,check,readOnly,open,modal,slow,close,list,result});
    var timer=new Timer {Interval=250};timer.Tick+=(s,e)=>details();timer.Start();save();details();
    try{Application.Run(form);}finally{timer.Dispose();if(other!=null&&!other.IsDisposed)other.Close();}
  }
}
